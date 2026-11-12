/**
 * Monitor de vagas PNV — Cloudflare Workers Free (V28: ciclo semestral automático)
 *
 * - Turmas são separadas por semestre (datas Início/Fim do Júpiter). Quando o
 *   Júpiter retira a oferta, o último retrato fica congelado; após o fim do
 *   semestre, ele é arquivado sozinho e o próximo semestre ocupa a tela.
 * - Interface estática servida pelo próprio Worker.
 * - Dados ficam no Workers KV.
 * - Um Cron a cada 5 min executa as atualizações no servidor.
 * - A varredura completa começa à 00:00 de America/Sao_Paulo e é dividida
 *   em lotes para respeitar o teto gratuito de subrequisições externas.
 * - Histórico diário é mantido sem prazo fixo: só os meses mais antigos
 *   são removidos automaticamente quando a reserva de armazenamento se aproxima da cota.
 */

const URL_LISTA_PNV = 'https://uspdigital.usp.br/jupiterweb/jupDisciplinaLista?codcg=3&pfxdisval=PNV&tipo=D';
const URL_TURMA = 'https://uspdigital.usp.br/jupiterweb/obterTurma?sgldis=';

// Estruturas curriculares oficiais da Escola Politécnica. A classificação
// por semestre não é mantida manualmente no código: ela é lida diretamente
// das habilitações atual e históricas do Júpiter a cada varredura completa.
const URL_HABILITACOES_ATUAIS = 'https://uspdigital.usp.br/jupiterweb/jupCursoLista?codcg=3&tipo=N';
const URL_HABILITACOES_ANTIGAS = 'https://uspdigital.usp.br/jupiterweb/jupCursoLista?codcg=3&tipo=V';
const URL_BASE_JUPITER = 'https://uspdigital.usp.br/jupiterweb/';

// Preencha somente quando a CoC confirmar formalmente que uma disciplina foi
// substituída por outra. O Júpiter informa a desativação, mas não informa
// com confiabilidade qual é a sucessora, então o monitor não tenta adivinhar.
const SUBSTITUICOES_MANUAIS = Object.freeze({
  // Exemplo: PNV0000: { codigo: 'PNV0001', nome: 'Nome da disciplina sucessora' }
});

const KEY_DADOS = 'monitor:latest';
const KEY_ESTADO = 'monitor:state';
// Histórico V2: dividido por mês para manter dados diários por tempo indeterminado.
// O índice acompanha o tamanho estimado e remove somente os meses mais antigos
// quando a reserva configurada para o KV estiver próxima do limite do plano Free.
const KEY_HISTORICO_LEGADO = 'monitor:history:v1';
const KEY_HISTORICO_INDICE = 'monitor:history:index:v2';
const PREFIXO_HISTORICO_MES = 'monitor:history:month:v2:';

// O plano Free do Workers KV oferece 1 GB. O Worker não recebe o uso total
// exato do namespace, então acompanha os bytes que ele mesmo gravou no
// histórico. A reserva deixa espaço para o monitor atual, o estado do scan e
// pequenas diferenças de serialização/metadata do KV.
const LIMITE_HISTORICO_BYTES = 820 * 1024 * 1024; // inicia a retenção automática.
const ALVO_HISTORICO_BYTES = 780 * 1024 * 1024; // reduz até esta faixa após cruzar o limite.
const LIMITE_VALOR_HISTORICO_BYTES = 24 * 1024 * 1024; // abaixo de 25 MiB por chave do KV.

const ROTA_SINCRONIZAR_APOS_DEPLOY = '/internal/sincronizar-apos-deploy';

// Ciclo semestral automático. Semestres encerrados vão para chaves próprias do
// KV (uma por semestre, poucos KB cada) e deixam a área principal do site.
const PREFIXO_SEMESTRE_ARQUIVADO = 'monitor:semestre:arquivo:v1:';
const CARENCIA_ARQUIVAMENTO_DIAS = 14; // após o "Fim" das turmas no Júpiter.
const LIMITE_ARQUIVAMENTO_FORCADO_DIAS = 60; // arquiva mesmo se o Júpiter ainda exibir.
const ANTECEDENCIA_PROXIMO_SEMESTRE_DIAS = 75; // mostra "próximo semestre" antes do fim do atual.

// Configuração deliberadamente conservadora.
// O monitor prioriza consistência dos dados do Júpiter, não velocidade.
// Cada execução faz poucas consultas, sempre uma por vez, com pausas.
const TAMANHO_LOTE_COMPLETO = 5;
const TAMANHO_LOTE_CURTO = 3;
const ESPERA_ENTRE_CONSULTAS_MS = 3_000;
const TIMEOUT_MS = 25_000;
const MAX_TENTATIVAS_POR_DISCIPLINA = 3;
const ESPERAS_ENTRE_TENTATIVAS_MS = [7_000, 20_000];
const PAUSA_PADRAO_429_MS = 30_000;

const CABECALHOS_JUPITER = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'pt-BR,pt;q=0.9,en;q=0.7'
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Rota exclusiva do processo de deploy. Ela é protegida por segredo e não é
    // chamada pelo navegador dos visitantes; apenas o comando de publicação a usa.
    if (url.pathname === ROTA_SINCRONIZAR_APOS_DEPLOY) {
      return iniciarSincronizacaoAposDeploy(request, env);
    }

    if (url.pathname === '/api/monitor') {
      // Esta rota é somente de leitura. Ela nunca inicia consultas ao Júpiter,
      // nem altera o KV. Todas as atualizações acontecem exclusivamente pelo
      // Cron Trigger do Worker, no relógio do servidor.
      const [dados, estado] = await Promise.all([lerDados(env), lerEstado(env)]);
      return respostaJson(await montarResposta(dados, estado, env, url.searchParams.get('semestre')));
    }

    if (url.pathname === '/api/historico') {
      // Histórico também é somente leitura. Os snapshots são gravados no fim
      // de cada varredura diária completa, nunca por interação do visitante.
      return respostaJson(await responderHistorico(url, env));
    }

    if (url.pathname === '/api/health') {
      return respostaJson({ ok: true, agora: Date.now() });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(executarCiclo(env, controller.scheduledTime || Date.now()));
  }
};

async function executarCiclo(env, instante) {
  const [dados, estado] = await Promise.all([lerDados(env), lerEstado(env)]);
  const agora = Number(instante) || Date.now();
  const hojeBrt = dataBrt(agora);

  try {
    // Primeiro uso, novo dia ou lista ainda não sincronizada: inicia scan completo.
    if (!estado.full || estado.full.data !== hojeBrt) {
      await iniciarScanCompleto(env, dados, estado, hojeBrt, agora);
      return;
    }

    // Enquanto existir scan diário pendente, cada ciclo de cinco minutos processa
    // outro lote. O site continua servindo o último conjunto válido.
    if (estado.full.emAndamento) {
      await processarLoteCompleto(env, dados, estado, agora);
      return;
    }

    await executarAtualizacaoCurta(env, dados, estado, agora);
  } catch (erro) {
    console.error('Falha no ciclo programado:', erro?.stack || erro);
    dados.ultimoErro = {
      em: agora,
      mensagem: mensagemErro(erro)
    };

    // O próximo ciclo agendado pelo Cron fará uma nova tentativa.
    if (!estado.full) estado.inicializacaoSolicitadaEm = null;
    await Promise.all([salvarDados(env, dados), salvarEstado(env, estado)]);
  }
}

async function iniciarScanCompleto(env, dados, estado, hojeBrt, agora, { processarPrimeiroLote = true } = {}) {
  // Arquivamento/abertura de semestres não depende do Júpiter estar no ar.
  await manterCicloDeSemestres(env, dados, hojeBrt, agora);

  const catalogo = await buscarCatalogoAtual();
  if (!catalogo.ok) throw new Error(`Não foi possível ler a lista PNV: ${catalogo.erro}`);

  // A lista oficial do Júpiter já traz Ativação e Desativação. Uma data de
  // desativação passada significa encerramento administrativo definitivo;
  // isso é diferente de simplesmente não haver turma neste semestre.
  sincronizarCompartimentoDesativadas(dados, catalogo.disciplinas, hojeBrt, agora);
  const disciplinasAtivas = catalogo.disciplinas.filter((disciplina) => !disciplinaEstaDesativada(disciplina, hojeBrt));

  // Lê a grade curricular da habilitação atual e, somente para os códigos
  // que não estiverem nela, procura a estrutura naval histórica mais recente.
  // Se o Júpiter oscilar, preservamos a última classificação válida em vez de
  // interromper a varredura de vagas ou inventar um semestre.
  await atualizarClassificacaoCurricular(dados, disciplinasAtivas, agora);

  await prepararScanCompleto(env, dados, estado, disciplinasAtivas, hojeBrt, agora);

  if (processarPrimeiroLote) {
    await processarLoteCompleto(env, dados, estado, agora);
  }
}

async function prepararScanCompleto(env, dados, estado, catalogoAtivo, hojeBrt, agora) {
  const codigos = catalogoAtivo.map((disciplina) => disciplina.codigo);
  const conjuntoAtual = new Set(codigos);
  estado.inicializacaoSolicitadaEm = null;

  // Uma disciplina que saiu da lista oficial deixa de fazer parte do monitor.
  dados.disciplinas = (dados.disciplinas || []).filter((d) => conjuntoAtual.has(d.codigo));
  dados.ultimaListaPNV = agora;
  dados.ultimoErro = null;

  estado.full = {
    data: hojeBrt,
    emAndamento: true,
    total: codigos.length,
    concluidas: 0,
    comTurmas: 0,
    semOferta: 0,
    falhas: 0,
    fila: codigos.map((codigo) => ({ codigo, tentativa: 0 })),
    codigos: [...codigos],
    confirmadas: {},
    iniciadoEm: agora,
    concluidoEm: null
  };

  await Promise.all([salvarDados(env, dados), salvarEstado(env, estado)]);
}

async function iniciarSincronizacaoAposDeploy(request, env) {
  // Esta rota não deve revelar que existe um comando administrativo: quem não
  // apresenta o segredo recebe 404, igual a uma rota inexistente.
  if (request.method !== 'POST' || !segredoConfere(request.headers.get('x-deploy-sync-token'), env.DEPLOY_SYNC_TOKEN)) {
    return new Response('Not Found', { status: 404 });
  }

  const agora = Date.now();
  const [dados, estado] = await Promise.all([lerDados(env), lerEstado(env)]);

  try {
    // A chamada do deploy consulta a lista oficial do Júpiter imediatamente e
    // persiste a fila. Os Cron Triggers assumem as turmas em seguida, sempre
    // no ritmo lento configurado — sem depender de uma visita ao site.
    await iniciarScanCompleto(env, dados, estado, dataBrt(agora), agora, { processarPrimeiroLote: false });

    return respostaJson({
      aceito: true,
      iniciadoEm: agora,
      proximoLotePeloCron: proximoMultiploDeCincoMinutos(agora)
    }, 202);
  } catch (erro) {
    console.error('Falha ao iniciar sincronização após deploy:', erro?.stack || erro);
    return respostaJson({ aceito: false, erro: mensagemErro(erro) }, 502);
  }
}

function segredoConfere(recebido, esperado) {
  if (!recebido || !esperado || recebido.length !== esperado.length) return false;
  let diferenca = 0;
  for (let indice = 0; indice < recebido.length; indice += 1) {
    diferenca |= recebido.charCodeAt(indice) ^ esperado.charCodeAt(indice);
  }
  return diferenca === 0;
}

async function processarLoteCompleto(env, dados, estado, agora) {
  const full = estado.full;
  const tarefas = full.fila.splice(0, TAMANHO_LOTE_COMPLETO);
  if (!tarefas.length) {
    full.emAndamento = false;
    full.concluidoEm = agora;
    dados.ultimaConsultaCompleta = agora;
    dados.ultimaAtualizacao = agora;
    dados.ultimoErro = null;
    ordenarDisciplinas(dados.disciplinas);
    await registrarSnapshotDiario(env, dados, full, agora);
    full.historicoRegistradoEm = agora;
    await Promise.all([salvarDados(env, dados), salvarEstado(env, estado)]);
    return;
  }

  const resultados = await consultarLote(tarefas.map((tarefa) => tarefa.codigo));
  const porCodigo = new Map(resultados.map((resultado) => [resultado.codigo, resultado]));

  for (const tarefa of tarefas) {
    const resultado = porCodigo.get(tarefa.codigo) || { codigo: tarefa.codigo, tipo: 'transitorio', erro: 'Sem resposta' };
    aplicarResultadoNoScan(dados, full, tarefa, resultado, agora);
  }

  dados.ultimaAtualizacao = agora;
  dados.ultimoErro = full.falhas
    ? { em: agora, mensagem: `${full.falhas} consulta(s) aguardando nova tentativa na sincronização diária.` }
    : null;
  ordenarDisciplinas(dados.disciplinas);

  if (!full.fila.length) {
    full.emAndamento = false;
    full.concluidoEm = agora;
    dados.ultimaConsultaCompleta = agora;
    await registrarSnapshotDiario(env, dados, full, agora);
    full.historicoRegistradoEm = agora;
  }

  await Promise.all([salvarDados(env, dados), salvarEstado(env, estado)]);
}

function aplicarResultadoNoScan(dados, full, tarefa, resultado, agora = Date.now()) {
  if (resultado.tipo === 'ofertada') {
    aplicarOferta(dados, resultado.disciplina, agora);
    full.confirmadas ||= {};
    full.confirmadas[tarefa.codigo] = 'ofertada';
    full.concluidas += 1;
    full.comTurmas += 1;
    return;
  }

  if (resultado.tipo === 'sem_oferta') {
    aplicarSemOferta(dados, tarefa.codigo, agora);
    full.confirmadas ||= {};
    full.confirmadas[tarefa.codigo] = 'sem_oferta';
    full.concluidas += 1;
    full.semOferta += 1;
    return;
  }

  // Falhas reais não apagam a versão antiga. Depois das três tentativas locais,
  // deixamos mais uma rodada para o ciclo seguinte antes de encerrar o código.
  full.falhas += 1;
  if (tarefa.tentativa < 1) {
    full.fila.push({ codigo: tarefa.codigo, tentativa: tarefa.tentativa + 1 });
    return;
  }

  full.concluidas += 1;
}

async function executarAtualizacaoCurta(env, dados, estado, agora) {
  let codigos = (dados.disciplinas || []).map((disciplina) => disciplina.codigo);
  if (!codigos.length) {
    // Entre semestres nada está ofertado. Em vez de ficar parado até a
    // meia-noite, a atualização curta percorre a lista oficial inteira para
    // abrir o próximo semestre assim que a primeira turma for cadastrada.
    codigos = Array.isArray(estado.full?.codigos) ? [...estado.full.codigos] : [];
  }
  if (!codigos.length) {
    // Não há nada para atualizar: no próximo ciclo o scan diário será refeito se necessário.
    dados.ultimaAtualizacao = agora;
    await salvarDados(env, dados);
    return;
  }

  const cursor = Number(estado.cursorCurto || 0) % codigos.length;
  const lote = [];
  for (let indice = 0; indice < Math.min(TAMANHO_LOTE_CURTO, codigos.length); indice += 1) {
    lote.push(codigos[(cursor + indice) % codigos.length]);
  }

  const resultados = await consultarLote(lote);
  let falhas = 0;
  for (const resultado of resultados) {
    if (resultado.tipo === 'ofertada') {
      aplicarOferta(dados, resultado.disciplina, agora);
    } else if (resultado.tipo === 'sem_oferta') {
      aplicarSemOferta(dados, resultado.codigo, agora);
    } else {
      falhas += 1;
    }
  }

  estado.cursorCurto = (cursor + lote.length) % Math.max(1, codigos.length);
  dados.ultimaAtualizacaoCurta = agora;
  dados.ultimaAtualizacao = agora;
  dados.ultimoErro = falhas ? { em: agora, mensagem: `${falhas} disciplina(s) mantiveram os dados anteriores nesta atualização curta.` } : null;
  ordenarDisciplinas(dados.disciplinas);
  await Promise.all([salvarDados(env, dados), salvarEstado(env, estado)]);
}

async function buscarCatalogoAtual() {
  const resposta = await buscarTexto(URL_LISTA_PNV);
  if (!resposta.ok) return { ok: false, erro: resposta.erro };

  const disciplinas = extrairCatalogoPNVDaLista(resposta.html);
  return disciplinas.length
    ? { ok: true, disciplinas }
    : { ok: false, erro: 'A lista não continha códigos PNV reconhecíveis.' };
}

async function atualizarClassificacaoCurricular(dados, catalogoAtivo, agora) {
  const codigos = (catalogoAtivo || []).map((item) => item.codigo).filter((codigo) => /^PNV\d{4}$/i.test(codigo));
  const anteriores = dados.curriculo?.porCodigo || {};

  try {
    const resultado = await buscarClassificacaoCurricular(codigos, agora);
    if (resultado.ok) {
      // A consulta curricular acontece antes do scan de turmas e pode sofrer
      // indisponibilidade parcial. Nunca apagamos um semestre já confirmado
      // só porque uma grade histórica falhou nesta execução.
      const porCodigo = {};
      for (const codigo of codigos) {
        if (resultado.curriculo?.porCodigo?.[codigo]) {
          porCodigo[codigo] = resultado.curriculo.porCodigo[codigo];
        } else if (anteriores[codigo]) {
          porCodigo[codigo] = anteriores[codigo];
        }
      }

      dados.curriculo = {
        ...resultado.curriculo,
        porCodigo,
        versao: 2,
        pendentes: codigos.filter((codigo) => !porCodigo[codigo]),
        ultimoErro: resultado.curriculo?.ultimoErro || null
      };
      return;
    }

    // Não apaga uma classificação útil por uma indisponibilidade momentânea.
    if (!dados.curriculo) {
      dados.curriculo = {
        versao: 2,
        atualizadoEm: null,
        porCodigo: {},
        pendentes: [...codigos],
        fontes: [],
        ultimoErro: resultado.erro || 'Não foi possível consultar as habilitações curriculares.'
      };
    } else {
      dados.curriculo.ultimoErro = resultado.erro || 'Não foi possível atualizar as habilitações curriculares.';
      dados.curriculo.tentativaEm = agora;
      dados.curriculo.pendentes = codigos.filter((codigo) => !dados.curriculo.porCodigo?.[codigo]);
    }
  } catch (erro) {
    if (!dados.curriculo) dados.curriculo = { versao: 2, atualizadoEm: null, porCodigo: {}, pendentes: [...codigos], fontes: [] };
    dados.curriculo.ultimoErro = mensagemErro(erro);
    dados.curriculo.tentativaEm = agora;
    dados.curriculo.pendentes = codigos.filter((codigo) => !dados.curriculo.porCodigo?.[codigo]);
    console.error('Falha na classificação curricular:', erro?.stack || erro);
  }
}

/**
 * Lê a habilitação naval atual primeiro. Para cada código PNV que não aparece
 * na estrutura atual, percorre as habilitações históricas da mais recente para
 * a mais antiga, parando assim que encontra o semestre da disciplina.
 */
async function buscarClassificacaoCurricular(codigosAlvo, agora) {
  const alvo = new Set((codigosAlvo || []).map((codigo) => String(codigo).toUpperCase()));
  const porCodigo = new Map();
  const fontesUsadas = [];
  const erros = [];

  const atual = await buscarHabilitacoesNavais(URL_HABILITACOES_ATUAIS, 'N');
  if (atual.ok) {
    for (const habilitacao of ordenarHabilitacoes(atual.habilitacoes)) {
      const grade = await buscarGradeCurricular(habilitacao, 'atual');
      if (!grade.ok) {
        erros.push(`${habilitacao.identificador}: ${grade.erro}`);
        continue;
      }
      fontesUsadas.push(grade.fonte);
      registrarDisciplinasCurriculares(porCodigo, grade.disciplinas, 0);
    }
  } else {
    erros.push(`habilitação atual: ${atual.erro}`);
  }

  const pendentes = () => [...alvo].filter((codigo) => !porCodigo.has(codigo));

  // A lista V é usada apenas quando a disciplina não pertence à habilitação
  // atual. A ordenação pelo código curricular coloca a versão mais recente
  // antes das anteriores, sem manter uma lista fixa de códigos no aplicativo.
  if (pendentes().length) {
    const antigas = await buscarHabilitacoesNavais(URL_HABILITACOES_ANTIGAS, 'V');
    if (antigas.ok) {
      for (const habilitacao of ordenarHabilitacoes(antigas.habilitacoes)) {
        if (!pendentes().length) break;
        const grade = await buscarGradeCurricular(habilitacao, 'historica');
        if (!grade.ok) {
          erros.push(`${habilitacao.identificador}: ${grade.erro}`);
          continue;
        }
        fontesUsadas.push(grade.fonte);
        registrarDisciplinasCurriculares(porCodigo, grade.disciplinas, 1);
      }
    } else {
      erros.push(`habilitações históricas: ${antigas.erro}`);
    }
  }

  const mapeamento = {};
  for (const [codigo, item] of porCodigo) {
    if (!alvo.size || alvo.has(codigo)) {
      const { _prioridade, ...limpo } = item;
      mapeamento[codigo] = limpo;
    }
  }

  const encontrou = Object.keys(mapeamento).length > 0;
  return {
    ok: encontrou || !alvo.size,
    erro: encontrou ? null : (erros.join(' · ') || 'Nenhuma disciplina PNV foi localizada nas grades curriculares.'),
    curriculo: {
      versao: 1,
      atualizadoEm: agora,
      porCodigo: mapeamento,
      fontes: deduplicarFontesCurriculares(fontesUsadas),
      ultimoErro: erros.length ? erros.join(' · ').slice(0, 800) : null
    }
  };
}

async function buscarHabilitacoesNavais(url, tipoEsperado) {
  const resposta = await buscarTexto(url);
  if (!resposta.ok) return { ok: false, erro: resposta.erro, habilitacoes: [] };

  const habilitacoes = extrairHabilitacoesNavais(resposta.html, tipoEsperado);
  return habilitacoes.length
    ? { ok: true, habilitacoes }
    : { ok: false, erro: 'A lista não trouxe links de grade para Engenharia Naval.', habilitacoes: [] };
}

function extrairHabilitacoesNavais(html, tipoEsperado) {
  const fonte = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const resultado = new Map();
  let ordem = 0;

  const registrarDoTrecho = (trecho, textoContexto) => {
    if (!/\bEngenharia\s+Naval(?:\s+e\s+Oce[aâ]nica)?\b/i.test(textoContexto || '')) return;
    if (/\bEngenharia\s+Nuclear\b/i.test(textoContexto || '')) return;

    const regexLink = /<a\b[^>]*\bhref\s*=\s*(?:["']([^"']+)["']|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
    for (const achado of String(trecho || '').matchAll(regexLink)) {
      const href = decodificarEntidadesHtml(achado[1] || achado[2] || '').trim();
      let absoluto;
      try { absoluto = new URL(href, URL_BASE_JUPITER); } catch { continue; }
      if (!/listarGradeCurricular/i.test(absoluto.pathname)) continue;

      const codcur = Number.parseInt(absoluto.searchParams.get('codcur') || '', 10);
      const codhab = Number.parseInt(absoluto.searchParams.get('codhab') || '0', 10);
      const tipo = String(absoluto.searchParams.get('tipo') || tipoEsperado || '').toUpperCase();
      if (!Number.isFinite(codcur)) continue;

      const chave = `${codcur}|${Number.isFinite(codhab) ? codhab : 0}|${tipo}`;
      if (resultado.has(chave)) continue;
      resultado.set(chave, {
        codcur,
        codhab: Number.isFinite(codhab) ? codhab : 0,
        tipo,
        url: absoluto.toString(),
        ordem: ordem += 1,
        identificador: `${codcur}-${Number.isFinite(codhab) ? codhab : 0}`,
        descricao: normalizarTexto(textoContexto).slice(0, 300)
      });
    }
  };

  const regexLinha = /<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi;
  let encontrouLinha = false;
  for (const linha of fonte.matchAll(regexLinha)) {
    encontrouLinha = true;
    registrarDoTrecho(linha[0], textoDaPagina(linha[0]));
  }

  // Algumas versões do Júpiter não usam <tr> na lista. Nelas, procuramos cada
  // link em uma janela de contexto que ainda contém o nome da habilitação.
  if (!resultado.size || !encontrouLinha) {
    const regexLinkAmplo = /<a\b[^>]*\bhref\s*=\s*(?:["']([^"']+)["']|([^\s>]+))[^>]*>[\s\S]*?<\/a\s*>/gi;
    for (const achado of fonte.matchAll(regexLinkAmplo)) {
      const inicio = Math.max(0, (achado.index || 0) - 900);
      const fim = Math.min(fonte.length, (achado.index || 0) + achado[0].length + 900);
      const trecho = fonte.slice(inicio, fim);
      registrarDoTrecho(achado[0], textoDaPagina(trecho));
    }
  }

  return [...resultado.values()];
}

function ordenarHabilitacoes(habilitacoes) {
  return [...(habilitacoes || [])].sort((a, b) => (
    Number(b.codcur || 0) - Number(a.codcur || 0)
    || Number(b.codhab || 0) - Number(a.codhab || 0)
    || Number(a.ordem || 0) - Number(b.ordem || 0)
  ));
}

async function buscarGradeCurricular(habilitacao, origem) {
  const resposta = await buscarTexto(habilitacao.url);
  if (!resposta.ok) return { ok: false, erro: resposta.erro };

  const disciplinas = extrairDisciplinasDaGradeCurricular(resposta.html, habilitacao, origem);
  return disciplinas.length
    ? {
        ok: true,
        disciplinas,
        fonte: {
          origem,
          codcur: habilitacao.codcur,
          codhab: habilitacao.codhab,
          tipo: habilitacao.tipo,
          url: habilitacao.url,
          identificador: habilitacao.identificador
        }
      }
    : { ok: false, erro: 'A grade não trouxe disciplinas PNV com período reconhecido.' };
}

function extrairDisciplinasDaGradeCurricular(html, habilitacao, origem) {
  const resultado = new Map();
  let periodoAtual = null;
  let contextoAtual = null;

  const contextoDaLinha = (texto) => {
    const limpo = normalizarTexto(texto);
    // Só considera cabeçalho de optativas quando a linha não contém código de
    // disciplina. Isso evita confundir uma vaga “Optativa Livre” com categoria
    // curricular da disciplina obrigatória.
    if (!/\bPNV\s*\d{4}\b/i.test(limpo) && /\bdisciplinas?\s+optativas?\b|\boptativas?\b/i.test(limpo)) return 'optativa';
    if (!/\bPNV\s*\d{4}\b/i.test(limpo) && /\bdisciplinas?\s+obrigat[oó]rias?\b/i.test(limpo)) return 'obrigatoria';
    return null;
  };

  const registrar = (texto, periodoDaLinha = null) => {
    const periodo = periodoDaLinha || periodoAtual;
    const temPeriodo = Number.isInteger(periodo) && periodo >= 1 && periodo <= 20;
    for (const achado of String(texto || '').matchAll(/\b(PNV\s*\d{4})\b/gi)) {
      const codigo = achado[1].replace(/\s+/g, '').toUpperCase();
      // A primeira ocorrência no currículo mais atual tem precedência; nunca
      // substituímos um semestre ideal por uma seção genérica de optativas.
      if (!resultado.has(codigo) || (temPeriodo && !Number.isInteger(resultado.get(codigo)?.periodo))) {
        resultado.set(codigo, {
          codigo,
          periodo: temPeriodo ? periodo : null,
          rotulo: temPeriodo ? rotuloCurricular(periodo) : '',
          tipoCurricular: !temPeriodo && contextoAtual === 'optativa' ? 'optativa' : null,
          origem,
          codcur: habilitacao.codcur,
          codhab: habilitacao.codhab,
          tipo: habilitacao.tipo,
          fonte: habilitacao.identificador
        });
      }
    }
  };

  // A grade normalmente apresenta um cabeçalho “nº semestre/período” seguido
  // pelas linhas das disciplinas. Mantemos o último cabeçalho visto.
  for (const celulas of extrairLinhasDeTabelaHtml(html)) {
    const texto = normalizarTexto((celulas || []).join(' ').replace(/\u241D/g, ' '));
    if (!texto) continue;
    const contexto = contextoDaLinha(texto);
    if (contexto) contextoAtual = contexto;
    const periodoDaLinha = extrairPeriodoCurricular(texto, celulas);
    if (periodoDaLinha) {
      periodoAtual = periodoDaLinha;
      contextoAtual = 'obrigatoria';
    }
    registrar(texto, periodoDaLinha);
  }

  // Fallback para páginas cuja tabela foi simplificada: conserva a ordem das
  // linhas e reconhece cabeçalhos de semestre fora de <tr>.
  if (!resultado.size) {
    for (const linha of textoEstruturadoDaPagina(html).split(/\n+/)) {
      const texto = normalizarTexto(linha.replace(/\u241F/g, ' '));
      const contexto = contextoDaLinha(texto);
      if (contexto) contextoAtual = contexto;
      const periodoDaLinha = extrairPeriodoCurricular(texto);
      if (periodoDaLinha) {
        periodoAtual = periodoDaLinha;
        contextoAtual = 'obrigatoria';
      }
      registrar(texto, periodoDaLinha);
    }
  }

  return [...resultado.values()];
}

function extrairPeriodoCurricular(texto, celulas = []) {
  const fonte = normalizarTexto([texto, ...(celulas || [])].join(' '));
  const padroes = [
    /(?:^|\b)(\d{1,2})\s*(?:º|ª|o)?\s*(?:semestre|per[ií]odo)\b/i,
    /\b(?:semestre|per[ií]odo)\s*(?:ideal)?\s*[:\-]?\s*(\d{1,2})\b/i,
    /\b(\d{1,2})\s*(?:º|ª)\s*sem\.?\b/i
  ];
  for (const padrao of padroes) {
    const achado = fonte.match(padrao);
    const periodo = Number.parseInt(achado?.[1] || '', 10);
    if (Number.isInteger(periodo) && periodo >= 1 && periodo <= 20) return periodo;
  }
  return null;
}

function rotuloCurricular(periodo) {
  // A grade do Júpiter informa o semestre ideal. O ano é apenas a conversão
  // aritmética desse próprio semestre (dois semestres por ano), sem uma lista
  // manual de códigos de disciplinas.
  const ano = Math.ceil(Number(periodo) / 2);
  return `${ano}º ano · ${periodo}º semestre`;
}

function registrarDisciplinasCurriculares(destino, disciplinas, prioridade) {
  for (const item of disciplinas || []) {
    const atual = destino.get(item.codigo);
    if (!atual || Number(prioridade) < Number(atual._prioridade ?? 99)) {
      destino.set(item.codigo, { ...item, _prioridade: prioridade });
    }
  }
}

function deduplicarFontesCurriculares(fontes) {
  const vistas = new Set();
  return (fontes || []).filter((fonte) => {
    const chave = `${fonte.origem}|${fonte.codcur}|${fonte.codhab}|${fonte.tipo}`;
    if (vistas.has(chave)) return false;
    vistas.add(chave);
    return true;
  });
}

/**
 * Lê a tabela pública “Sigla | Nome | Ativação | Desativação” do Júpiter.
 * A data vazia é mantida como null. Caso haja uma data de desativação já
 * alcançada, a disciplina sai do monitor de oferta e entra no compartimento
 * de desativadas — sem confundir esse caso com “sem turma neste semestre”.
 */
function extrairCatalogoPNVDaLista(html) {
  const resultado = new Map();
  const linhas = extrairLinhasDeTabelaHtml(html);

  for (const celulas of linhas) {
    const campos = (celulas || []).map(normalizarTexto).filter(Boolean);
    const textoLinha = normalizarTexto(campos.join(' '));
    const codigoEncontrado = textoLinha.match(/\b(PNV\s*\d{4})\b/i);
    if (!codigoEncontrado) continue;

    const codigo = codigoEncontrado[1].replace(/\s+/g, '').toUpperCase();
    const datas = Array.from(textoLinha.matchAll(/\b(\d{2}\/\d{2}\/\d{4})\b/g), (item) => normalizarDataJupiter(item[1]));
    const indiceCodigo = campos.findIndex((campo) => new RegExp(`\\b${codigo}\\b`, 'i').test(campo));
    let nome = indiceCodigo >= 0 ? normalizarTexto(campos[indiceCodigo + 1] || '') : '';

    // Algumas versões da página deixam código e nome na mesma célula. Neste
    // caso removemos código e datas antes de aceitar o nome.
    if (!nome || /^\d{2}\/\d{2}\/\d{4}$/.test(nome)) {
      nome = normalizarTexto(textoLinha
        .replace(new RegExp(`\\b${codigo}\\b`, 'ig'), ' ')
        .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, ' ')
        .replace(/\b(?:Sigla|Nome|Ativa(?:ç|c)[aã]o|Desativa(?:ç|c)[aã]o)\b/gi, ' '));
    }

    if (!nome || /^PNV\d{4}$/i.test(nome)) nome = codigo;
    resultado.set(codigo, {
      codigo,
      nome,
      ativacao: datas[0] || null,
      desativacao: datas[1] || null
    });
  }

  // Fallback para alterações no HTML da listagem: continua monitorando os
  // códigos conhecidos, mas sem inventar datas de ativação/desativação.
  if (!resultado.size) {
    for (const item of textoDaPagina(html).matchAll(/\bPNV\s*(\d{4})\b/gi)) {
      const codigo = `PNV${item[1]}`;
      resultado.set(codigo, { codigo, nome: codigo, ativacao: null, desativacao: null });
    }
  }

  return [...resultado.values()].sort((a, b) => a.codigo.localeCompare(b.codigo));
}

function normalizarDataJupiter(valor) {
  const match = String(valor || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function disciplinaEstaDesativada(disciplina, hojeBrt) {
  return Boolean(disciplina?.desativacao && disciplina.desativacao <= hojeBrt);
}

function sincronizarCompartimentoDesativadas(dados, catalogo, hojeBrt, agora) {
  dados.desativadas ||= [];
  const porCodigo = new Map(dados.desativadas.map((disciplina) => [disciplina.codigo, disciplina]));
  const ativasNoCatalogo = new Set();

  for (const item of catalogo || []) {
    if (!disciplinaEstaDesativada(item, hojeBrt)) {
      ativasNoCatalogo.add(item.codigo);
      // Caso excepcional de reativação no Júpiter, devolve a disciplina ao
      // catálogo normal e remove a marca administrativa antiga.
      porCodigo.delete(item.codigo);
      continue;
    }

    const ofertaAtual = (dados.disciplinas || []).find((disciplina) => disciplina.codigo === item.codigo);
    const anterior = porCodigo.get(item.codigo) || {};
    const pessoas = ofertaAtual ? resumirPessoas(ofertaAtual) : (anterior.ultimaOferta?.pessoas || null);
    const substituidaPor = SUBSTITUICOES_MANUAIS[item.codigo] || anterior.substituidaPor || null;

    porCodigo.set(item.codigo, {
      codigo: item.codigo,
      nome: item.nome || anterior.nome || item.codigo,
      ativacao: item.ativacao || anterior.ativacao || null,
      desativacao: item.desativacao,
      detectadaEm: anterior.detectadaEm || agora,
      atualizadaEm: agora,
      ultimaOfertaEm: ofertaAtual?.atualizadaEm || anterior.ultimaOfertaEm || null,
      ultimaOferta: ofertaAtual
        ? {
            pessoas,
            inscritos: pessoas.inscritos,
            pendentes: pessoas.pendentes,
            matriculados: pessoas.matriculados
          }
        : (anterior.ultimaOferta || null),
      substituidaPor
    });

    // Não é apenas “sem turma”: como existe desativação administrativa, a
    // disciplina não deve voltar ao monitor de vagas ou à grade horária.
    removerDisciplina(dados.disciplinas || [], item.codigo);
  }

  // Uma entrada só sai do compartimento se o próprio catálogo a trouxer de
  // volta sem data de desativação. Se ela simplesmente desaparecer da página,
  // preservamos o registro histórico já detectado.
  dados.desativadas = [...porCodigo.values()]
    .filter((disciplina) => !ativasNoCatalogo.has(disciplina.codigo))
    .sort((a, b) => String(b.desativacao || '').localeCompare(String(a.desativacao || '')) || a.codigo.localeCompare(b.codigo));
}

async function consultarLote(codigos) {
  const resultados = [];

  // Uma solicitação por vez. Isto evita rajadas contra o Júpiter e facilita
  // identificar/repetir uma resposta instável sem afetar as demais.
  for (let indice = 0; indice < codigos.length; indice += 1) {
    resultados.push(await buscarDisciplina(codigos[indice]));
    if (indice + 1 < codigos.length) await dormir(ESPERA_ENTRE_CONSULTAS_MS);
  }

  return resultados;
}

async function buscarDisciplina(codigo) {
  let ultimoResultado = null;

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_POR_DISCIPLINA; tentativa += 1) {
    if (tentativa > 0) {
      await dormir(esperaAntesDaTentativa(ultimoResultado, tentativa));
    }

    const resultado = await buscarDisciplinaUmaVez(codigo);
    if (resultado.tipo !== 'transitorio') return resultado;
    ultimoResultado = resultado;
  }

  // Depois das tentativas, o dado anterior é preservado pelo chamador.
  return ultimoResultado || { codigo, tipo: 'transitorio', erro: 'Sem resposta do Júpiter.' };
}

function esperaAntesDaTentativa(resultado, tentativa) {
  if (Number(resultado?.retryAfterMs) > 0) return Number(resultado.retryAfterMs);
  if (/HTTP 429/i.test(resultado?.erro || '')) return PAUSA_PADRAO_429_MS;
  return ESPERAS_ENTRE_TENTATIVAS_MS[tentativa - 1] || PAUSA_PADRAO_429_MS;
}

async function buscarDisciplinaUmaVez(codigo) {
  const resposta = await buscarTexto(`${URL_TURMA}${encodeURIComponent(codigo)}`);
  if (!resposta.ok) {
    return {
      codigo,
      tipo: 'transitorio',
      erro: resposta.erro,
      retryAfterMs: resposta.retryAfterMs || null
    };
  }

  const textoEstruturado = textoEstruturadoDaPagina(resposta.html);
  const texto = normalizarTexto(textoEstruturado.replace(/\u241F/g, ' '));

  // Quando a oferta \u00E9 retirada (fim do per\u00EDodo de consulta p\u00FAblica ou troca de
  // semestre), o J\u00FApiter n\u00E3o devolve a p\u00E1gina da disciplina: devolve apenas a
  // mensagem "N\u00E3o existe oferecimento para a sigla XXX". Antes isso era lido
  // como resposta incompleta e as turmas antigas ficavam no site para sempre.
  if (paginaConfirmaInexistenciaDeOferta(texto, codigo)) return { codigo, tipo: 'sem_oferta' };

  if (!paginaConfirmaDisciplina(texto, codigo)) {
    return { codigo, tipo: 'transitorio', erro: 'Resposta intermediária ou incompleta.' };
  }

  const turmas = extrairTurmas(texto, textoEstruturado, resposta.html);
  if (turmas.length) {
    return {
      codigo,
      tipo: 'ofertada',
      disciplina: {
        codigo,
        nome: extrairNome(texto, codigo),
        turmas,
        atualizadaEm: Date.now()
      }
    };
  }

  // Só consideramos “sem oferta” após uma página válida confirmar que não existe
  // sequer um código de turma. Se a página aponta uma turma, mas o parser não
  // conseguiu lê-la, preservamos os dados anteriores e tentamos novamente.
  if (paginaConfirmaSemOferta(texto)) return { codigo, tipo: 'sem_oferta' };

  return { codigo, tipo: 'transitorio', erro: 'A página indicou turma, mas os dados ficaram incompletos.' };
}

async function buscarTexto(url) {
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort('tempo-esgotado'), TIMEOUT_MS);
  try {
    const resposta = await fetch(url, {
      headers: CABECALHOS_JUPITER,
      signal: controlador.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });

    if (resposta.status === 429) {
      const retryAfterSegundos = Number(resposta.headers.get('retry-after'));
      return {
        ok: false,
        erro: 'HTTP 429 (limite temporário do Júpiter)',
        retryAfterMs: Number.isFinite(retryAfterSegundos) && retryAfterSegundos > 0
          ? retryAfterSegundos * 1_000
          : PAUSA_PADRAO_429_MS
      };
    }
    if (!resposta.ok) return { ok: false, erro: `HTTP ${resposta.status}` };

    // O Júpiter ainda entrega diversas páginas em Windows-1252/ISO-8859-1.
    // Response.text() sempre assume UTF-8 e transforma caracteres como “á” em
    // “ ”. Por isso lemos os bytes e escolhemos a decodificação mais plausível.
    const html = await decodificarHtmlDoJupiter(resposta);
    return html.length >= 100 ? { ok: true, html } : { ok: false, erro: 'Resposta vazia ou incompleta.' };
  } catch (erro) {
    const timeout = controlador.signal.aborted;
    return { ok: false, erro: timeout ? 'Tempo esgotado na consulta.' : mensagemErro(erro) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decodifica a resposta do Júpiter sem depender do charset declarado no header.
 * O site alterna entre páginas UTF-8 e páginas em Windows-1252/ISO-8859-1.
 */
async function decodificarHtmlDoJupiter(resposta) {
  const bytes = new Uint8Array(await resposta.arrayBuffer());
  const contentType = resposta.headers.get('content-type') || '';
  const charsetDeclarado = contentType.match(/charset\s*=\s*[\"']?([^;\s\"']+)/i)?.[1]?.toLowerCase() || '';

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const windows1252 = new TextDecoder('windows-1252', { fatal: false }).decode(bytes);

  const pontuacaoUtf8 = pontuarDecodificacao(utf8);
  const pontuacaoWindows1252 = pontuarDecodificacao(windows1252);
  const declaradoComoLatin = /(?:iso[-_]?8859[-_]?1|latin[-_]?1|windows[-_]?1252|cp1252)/i.test(charsetDeclarado);
  const declaradoComoUtf8 = /utf[-_]?8/i.test(charsetDeclarado);

  // Damos preferência ao charset declarado somente quando ele não produz texto
  // claramente pior. Isso corrige headers ausentes ou incorretos do Júpiter.
  if (declaradoComoLatin && pontuacaoWindows1252 <= pontuacaoUtf8 + 1) return windows1252;
  if (declaradoComoUtf8 && pontuacaoUtf8 <= pontuacaoWindows1252 + 1) return utf8;
  return pontuacaoWindows1252 < pontuacaoUtf8 ? windows1252 : utf8;
}

function pontuarDecodificacao(texto) {
  const valor = String(texto || '');
  const substituicoes = (valor.match(/\uFFFD/g) || []).length;
  const mojibake = (valor.match(/(?:Ã.|Â.|â..)/g) || []).length;
  const nulos = (valor.match(/\u0000/g) || []).length;
  return substituicoes * 20 + mojibake * 4 + nulos * 10;
}

function decodificarEntidadesHtml(valor) {
  const entidades = {
    amp: '&', lt: '<', gt: '>', quot: '\"', apos: "'", nbsp: ' ',
    aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä',
    eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
    iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
    oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
    uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
    ccedil: 'ç', ntilde: 'ñ', ordm: 'º', ordf: 'ª',
    Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã',
    Eacute: 'É', Ecirc: 'Ê', Iacute: 'Í', Oacute: 'Ó', Otilde: 'Õ',
    Uacute: 'Ú', Ccedil: 'Ç', Ntilde: 'Ñ'
  };

  return String(valor || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (inteiro, codigo) => {
    if (codigo[0] === '#') {
      const numero = codigo[1]?.toLowerCase() === 'x'
        ? Number.parseInt(codigo.slice(2), 16)
        : Number.parseInt(codigo.slice(1), 10);
      if (Number.isFinite(numero) && numero >= 0 && numero <= 0x10ffff) {
        try { return String.fromCodePoint(numero); } catch { return inteiro; }
      }
      return inteiro;
    }
    return entidades[codigo] || entidades[codigo.toLowerCase()] || inteiro;
  });
}

function textoEstruturadoDaPagina(html) {
  // Mantém separadores de células (␟) e linhas para recuperar os docentes,
  // que o Júpiter coloca em coluna separada do horário. O parser legado usa
  // a versão achatada abaixo, portanto isso não altera a leitura de vagas.
  const bruto = decodificarEntidadesHtml(
    String(html || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/tr\s*>/gi, '\n')
      .replace(/<\/(?:td|th)\s*>/gi, '\u241F')
      .replace(/<\/?(?:tr|p|div|li|h\d|table)[^>]*>/gi, '\n')
      .replace(/<(?:td|th)\b[^>]*>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  );

  return String(bruto || '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/ *\u241F */g, '\u241F')
    .replace(/\n{2,}/g, '\n')
    .replace(/\u241F{2,}/g, '\u241F')
    .trim();
}

function textoDaPagina(html) {
  return normalizarTexto(textoEstruturadoDaPagina(html).replace(/\u241F/g, ' '));
}

function paginaConfirmaDisciplina(texto, codigo) {
  const codigoSeguro = String(codigo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${codigoSeguro}\\b`, 'i').test(texto)
    && /Disciplina\s*:/i.test(texto)
    && /Lista\s+de\s+Turmas|Clique\s+para\s+consultar/i.test(texto);
}

function paginaConfirmaInexistenciaDeOferta(texto, codigo) {
  // O Júpiter às vezes entrega "Não" com o "ã" corrompido ("N?o", "N�o").
  const codigoSeguro = String(codigo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bN\\S{1,2}o\\s+existe\\s+oferecimento\\s+para\\s+a\\s+sigla\\s+${codigoSeguro}\\b`, 'i').test(texto);
}

function paginaIndicaCodigoDeTurma(texto) {
  return /C(?:[oó]| )digo\s+da\s+Turma\s*:\s*\d+/i.test(texto);
}

function paginaConfirmaSemOferta(texto) {
  return /Lista\s+de\s+Turmas\s+oferecidas/i.test(texto)
    && !paginaIndicaCodigoDeTurma(texto);
}

function extrairNome(texto, codigo) {
  const padrao = new RegExp(`Disciplina\\s*:\\s*(${codigo}\\s*[-–]\\s*.*?)\\s*(?:Clique\\s+para|Lista\\s+de\\s+Turmas|C(?:[oó]| )digo\\s+da\\s+Turma|$)`, 'i');
  return normalizarTexto(texto.match(padrao)?.[1] || `Disciplina ${codigo}`);
}

function extrairTurmas(texto, textoEstruturado = '', html = '') {
  const marcador = /C(?:[oó]| )digo\s+da\s+Turma\s*:\s*(\d+)/gi;
  const ocorrencias = Array.from(texto.matchAll(marcador));

  // O Júpiter muda a estrutura da coluna de docentes entre disciplinas.
  // Primeiro lemos as linhas/células originais da tabela (mais preciso);
  // depois usamos o texto estruturado e, por último, o texto achatado como
  // alternativas. Assim uma leitura parcial não derruba os nomes já achados.
  // A leitura por links preserva cada docente mesmo quando o Júpiter coloca
  // vários nomes na mesma célula, sem vírgula ou quebra visual. É a fonte
  // mais confiável; as demais são fallbacks para páginas antigas.
  const professoresPorLinks = extrairProfessoresPorTurmaComLinks(html);
  const professoresHtml = extrairProfessoresPorTurmaDoHtml(html);
  const professoresEstruturados = extrairProfessoresPorTurma(textoEstruturado);
  const turmas = [];
  const vistas = new Set();

  for (let indice = 0; indice < ocorrencias.length; indice += 1) {
    const inicio = ocorrencias[indice].index || 0;
    const fim = indice + 1 < ocorrencias.length ? (ocorrencias[indice + 1].index || texto.length) : texto.length;
    const bloco = texto.slice(inicio, fim);
    const codigo = ocorrencias[indice][1];
    const posicaoVagas = bloco.search(/Vagas\s+Inscritos\s+Pendentes\s+Matriculados/i);
    if (posicaoVagas < 0) continue;

    const antesDasVagas = bloco.slice(0, posicaoVagas);
    const horario = extrairHorario(antesDasVagas);
    const professores = escolherProfessores(
      professoresPorLinks.get(codigo),
      professoresHtml.get(codigo),
      professoresEstruturados.get(codigo),
      extrairProfessoresDoTextoPlano(antesDasVagas)
    );
    const tipo = extrairTipoTurma(antesDasVagas);
    const teoricaVinculada = extrairTurmaTeoricaVinculada(antesDasVagas);
    const periodoTurma = extrairPeriodoDaTurma(antesDasVagas);
    const semestre = identificarSemestreDaTurma(codigo, periodoTurma.inicio);

    for (const categoria of extrairCategorias(bloco.slice(posicaoVagas))) {
      const ocupadas = categoria.inscritos + categoria.pendentes + categoria.matriculados;
      const chave = [codigo, categoria.nome, categoria.vagas, categoria.inscritos, categoria.pendentes, categoria.matriculados].join('|');
      if (vistas.has(chave)) continue;
      vistas.add(chave);

      turmas.push({
        codigo,
        grupoTurma: teoricaVinculada || codigo,
        tipoTurma: tipo,
        turmaTeoricaVinculada: teoricaVinculada,
        inicio: periodoTurma.inicio,
        fim: periodoTurma.fim,
        semestre,
        horario,
        professores,
        dia: extrairDias(horario),
        categoria: categoria.nome,
        total: categoria.vagas,
        ocupadas,
        disponiveis: Math.max(0, categoria.vagas - ocupadas),
        inscritos: categoria.inscritos,
        pendentes: categoria.pendentes,
        matriculados: categoria.matriculados
      });
    }
  }

  return turmas;
}

function extrairTipoTurma(texto) {
  const encontrado = texto.match(/Tipo\s+da\s+Turma\s*:\s*(.*?)(?=\s+(?:Observa|Hor[aá]rio|Vagas)\b|$)/i);
  return normalizarTexto(encontrado?.[1] || '');
}

function extrairTurmaTeoricaVinculada(texto) {
  return texto.match(/C(?:[oó]| )digo\s+da\s+Turma\s+Te(?:[oó]| )rica\s*:\s*(\d+)/i)?.[1] || null;
}

/**
 * Cada turma do Júpiter traz "Início: dd/mm/aaaa" e "Fim: dd/mm/aaaa". São
 * essas datas que permitem separar turmas do semestre corrente das turmas do
 * próximo semestre quando as duas aparecem ao mesmo tempo.
 */
function extrairPeriodoDaTurma(texto) {
  const fonte = String(texto || '');
  const inicio = fonte.match(/\bIn\S{1,2}cio\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1];
  const fim = fonte.match(/\bFim\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)?.[1];
  return { inicio: normalizarDataJupiter(inicio), fim: normalizarDataJupiter(fim) };
}

function extrairHorario(texto) {
  const achado = texto.match(/Hor[aá]rio\s*(?:Prof\.?\(a\)\.?\s*)?(.*)$/i);
  const bruto = normalizarTexto(achado?.[1] || '');
  const limite = bruto.search(/\b(?:Vagas|Prof\.?\(a\)?)\b/i);
  const base = limite >= 0 ? bruto.slice(0, limite) : bruto;
  const horario = base.match(/(?:(?:seg|ter|qua|qui|sex|s[aá]b|dom)\s+\d{1,2}:\d{2}\s+\d{1,2}:\d{2}(?:\s*\([^)]*\))?\s*)+/i)?.[0];
  return normalizarTexto(horario || base) || 'Horário não informado';
}

/**
 * Leitura direta por links de docentes. Em várias páginas do Júpiter os
 * nomes ficam todos na mesma célula e são separados apenas por tags <a>;
 * quando as tags são removidas, "Nome A" e "Nome B" viram um único texto.
 * Aqui preservamos cada fechamento de link como separador antes de extrair.
 */
function extrairProfessoresPorTurmaComLinks(html) {
  const fonte = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/a\s*>/gi, '\u241D')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<\/(?:td|th)\s*>/gi, '\u241F')
    .replace(/<[^>]+>/g, ' ');

  const estrutura = decodificarEntidadesHtml(fonte)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/ *\u241F */g, '\u241F')
    .replace(/ *\u241D */g, '\u241D')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const marcador = /C(?:[oó]| )digo\s+da\s+Turma\s*:\s*(\d+)/gi;
  const ocorrencias = Array.from(estrutura.matchAll(marcador));
  const resultado = new Map();

  for (let indice = 0; indice < ocorrencias.length; indice += 1) {
    const inicio = ocorrencias[indice].index || 0;
    const fim = indice + 1 < ocorrencias.length
      ? (ocorrencias[indice + 1].index || estrutura.length)
      : estrutura.length;
    const codigo = ocorrencias[indice][1];
    const bloco = estrutura.slice(inicio, fim);
    const inicioHorario = bloco.search(/Hor[aá]rio\b/i);
    if (inicioHorario < 0) continue;

    const depoisDoHorario = bloco.slice(inicioHorario);
    const inicioVagas = depoisDoHorario.search(/Vagas\s+Inscritos\s+Pendentes\s+Matriculados/i);
    const trecho = inicioVagas >= 0 ? depoisDoHorario.slice(0, inicioVagas) : depoisDoHorario;

    // Os nomes extraídos de links ficam separados por U+241D. Também
    // preservamos células e linhas como separadores para os layouts antigos.
    const campos = trecho
      .split(/[\n\u241F\u241D]+/)
      .map(normalizarTexto)
      .filter(Boolean);
    const professores = extrairProfessoresDosCampos(campos);
    if (professores.length) adicionarProfessoresAoMapa(resultado, codigo, professores);
  }

  return resultado;
}

/**
 * Extrai docentes a partir das linhas reais da tabela HTML. Essa é a fonte
 * prioritária porque preserva os links e as células individuais que se perdem
 * quando a página é convertida para texto.
 */
function extrairProfessoresPorTurmaDoHtml(html) {
  const linhas = extrairLinhasDeTabelaHtml(html);
  const resultado = new Map();
  let codigoAtual = null;
  let dentroDoQuadroHorario = false;

  for (const campos of linhas) {
    const textoLinha = normalizarTexto(campos.join(' '));
    if (!textoLinha) continue;

    const encontradoCodigo = textoLinha.match(/C(?:[oó]| )digo\s+da\s+Turma\s*:\s*(\d+)/i);
    if (encontradoCodigo) {
      codigoAtual = encontradoCodigo[1];
      dentroDoQuadroHorario = false;
      if (!resultado.has(codigoAtual)) resultado.set(codigoAtual, []);
      continue;
    }

    if (!codigoAtual) continue;

    if (/Vagas\s+Inscritos\s+Pendentes\s+Matriculados/i.test(textoLinha)) {
      dentroDoQuadroHorario = false;
      continue;
    }

    // Cabeçalho típico: "Horário" | "Prof(a).". Em algumas páginas ambos
    // aparecem na mesma célula; basta a presença de Horário para abrir a área.
    if (/\bHor[aá]rio\b/i.test(textoLinha)) {
      dentroDoQuadroHorario = true;
      continue;
    }

    if (!dentroDoQuadroHorario) continue;

    // Linhas administrativas que não pertencem à grade de horário.
    if (/^(?:Observa(?:ç|c)[oõ]es?|In[ií]cio|Fim|Tipo\s+da\s+Turma|C(?:[oó]| )digo\s+da\s+Turma(?:\s+Te(?:[oó]| )rica)?|Clique\b)/i.test(textoLinha)) continue;

    const professores = extrairProfessoresDaLinhaDeTabela(campos);
    if (professores.length) adicionarProfessoresAoMapa(resultado, codigoAtual, professores);
  }

  // Remove chaves sem docente, para que os fallbacks sejam utilizados.
  for (const [codigo, nomes] of resultado.entries()) {
    const limpos = normalizarProfessores(nomes);
    if (limpos.length) resultado.set(codigo, limpos);
    else resultado.delete(codigo);
  }

  return resultado;
}

function extrairLinhasDeTabelaHtml(html) {
  const fonte = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ');

  const linhas = [];
  const regexLinha = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  for (const encontradoLinha of fonte.matchAll(regexLinha)) {
    const campos = [];
    const regexCelula = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi;
    for (const encontradoCelula of encontradoLinha[1].matchAll(regexCelula)) {
      const valor = textoDaCelulaHtml(encontradoCelula[1]);
      if (valor) campos.push(valor);
    }
    if (campos.length) linhas.push(campos);
  }
  return linhas;
}

function textoDaCelulaHtml(html) {
  // O Júpiter costuma colocar cada docente em um link. Ao trocar </a> por um
  // separador antes de retirar as tags, evitamos que "Nome ANome B" vire uma
  // única string quando duas âncoras aparecem lado a lado.
  const bruto = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\u241D')
    .replace(/<\/a\s*>/gi, '\u241D')
    .replace(/<[^>]+>/g, ' ');

  return decodificarEntidadesHtml(bruto)
    .replace(/[ \t\r\n\f\v]+/g, ' ')
    .replace(/\s*\u241D\s*/g, '\u241D')
    .replace(/\u241D{2,}/g, '\u241D')
    .trim();
}

function extrairProfessoresDaLinhaDeTabela(campos) {
  const nomes = [];
  for (const campo of campos || []) {
    for (const parte of String(campo || '').split(/\u241D|\s*[;|]\s*/)) {
      const nome = limparPossivelProfessor(parte);
      if (pareceNomeDeProfessor(nome)) nomes.push(nome);
    }
  }
  return normalizarProfessores(nomes);
}

function limparPossivelProfessor(valor) {
  return normalizarTexto(String(valor || '')
    .replace(/^\s*Hor[aá]rio\s*(?:Prof\.?\(a\)?\.?\s*)?/i, ' ')
    .replace(/^\s*Prof\.?\(a\)?\.?\s*/i, ' ')
    .replace(/\b(?:seg|ter|qua|qui|sex|s[aá]b|dom)\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\(\s*R\s*\)/gi, ' ')
    .replace(/\b(?:Hor[aá]rio|Prof\.?\(a\)?\.?|Sala|Local)\b\s*:?/gi, ' ')
    .replace(/^[-–—·,:;]+|[-–—·,:;]+$/g, ' '));
}

function pareceNomeDeProfessor(valor) {
  const nome = normalizarTexto(valor);
  if (!nome || nome.length < 5 || /\d/.test(nome)) return false;
  if (/^(?:Vagas|Inscritos|Pendentes|Matriculados|Observa(?:ç|c)[oõ]es?|In[ií]cio|Fim|Tipo\s+da\s+Turma|Te[oó]rica|Pr[aá]tica|Vinculada|C(?:[oó]| )digo\s+da\s+Turma|Clique\b)/i.test(nome)) return false;
  if (/\b(?:seg|ter|qua|qui|sex|s[aá]b|dom)\b/i.test(nome)) return false;

  // Docentes no Júpiter são nomes completos. Exigir dois termos evita que
  // campos como "R" ou "Laboratório" entrem como professor.
  const palavras = nome.match(/[A-Za-zÀ-ÖØ-öø-ÿ]{2,}/g) || [];
  return palavras.length >= 2;
}

function adicionarProfessoresAoMapa(mapa, codigo, nomes) {
  const anteriores = mapa.get(codigo) || [];
  mapa.set(codigo, normalizarProfessores([...anteriores, ...(nomes || [])]));
}

function extrairProfessoresPorTurma(textoEstruturado) {
  const estrutura = String(textoEstruturado || '');
  if (!estrutura) return new Map();

  const marcador = /C(?:[oó]| )digo\s+da\s+Turma\s*:\s*(\d+)/gi;
  const ocorrencias = Array.from(estrutura.matchAll(marcador));
  const resultado = new Map();

  for (let indice = 0; indice < ocorrencias.length; indice += 1) {
    const inicio = ocorrencias[indice].index || 0;
    const fim = indice + 1 < ocorrencias.length ? (ocorrencias[indice + 1].index || estrutura.length) : estrutura.length;
    const codigo = ocorrencias[indice][1];
    const bloco = estrutura.slice(inicio, fim);
    const professores = extrairProfessoresDoBlocoEstruturado(bloco);
    if (professores.length) adicionarProfessoresAoMapa(resultado, codigo, professores);
  }

  return resultado;
}

function extrairProfessoresDoBlocoEstruturado(bloco) {
  const inicioHorario = String(bloco || '').search(/Hor[aá]rio\b/i);
  if (inicioHorario < 0) return [];

  const depoisDoHorario = String(bloco).slice(inicioHorario);
  const inicioVagas = depoisDoHorario.search(/Vagas\s+Inscritos\s+Pendentes\s+Matriculados/i);
  const trecho = inicioVagas >= 0 ? depoisDoHorario.slice(0, inicioVagas) : depoisDoHorario;

  const campos = trecho
    .split(/[\n\u241F]+/)
    .map(normalizarTexto)
    .filter(Boolean);

  return extrairProfessoresDosCampos(campos);
}

function extrairProfessoresDoTextoPlano(texto) {
  const inicioHorario = String(texto || '').search(/Hor[aá]rio\b/i);
  if (inicioHorario < 0) return [];

  const depoisDoHorario = String(texto).slice(inicioHorario);
  const inicioVagas = depoisDoHorario.search(/Vagas\s+Inscritos\s+Pendentes\s+Matriculados/i);
  const trecho = inicioVagas >= 0 ? depoisDoHorario.slice(0, inicioVagas) : depoisDoHorario;

  const campos = trecho
    .replace(/\b(?:seg|ter|qua|qui|sex|s[aá]b|dom)\b\s+\d{1,2}:\d{2}\s+\d{1,2}:\d{2}(?:\s*\(R\))?/gi, (parte) => `\n${parte}\n`)
    .split(/\n+/)
    .map(normalizarTexto)
    .filter(Boolean);

  return extrairProfessoresDosCampos(campos);
}

function extrairProfessoresDosCampos(campos) {
  const nomes = [];
  let encontrouHorario = false;

  for (let campoOriginal of campos || []) {
    let campo = normalizarTexto(campoOriginal);
    if (!campo) continue;

    if (/^(?:Hor[aá]rio|Prof\.?\(a\)?\.?)$/i.test(campo)) continue;
    if (/^(?:Tipo\s+da\s+Turma|Observa(?:ç|c)[oõ]es?|In[ií]cio|Fim|C(?:[oó]| )digo\s+da\s+Turma(?:\s+Te(?:[oó]| )rica)?|Vagas|Inscritos|Pendentes|Matriculados)\b/i.test(campo)) break;

    const possuiDia = /\b(?:seg|ter|qua|qui|sex|s[aá]b|dom)\b/i.test(campo);
    const possuiHorario = /\b\d{1,2}:\d{2}\b/.test(campo);

    if (possuiDia || (encontrouHorario && possuiHorario)) {
      encontrouHorario = true;
      const restante = limparPossivelProfessor(campo);
      if (pareceNomeDeProfessor(restante)) nomes.push(restante);
      continue;
    }

    if (!encontrouHorario) continue;
    if (/^(?:\d{1,2}:\d{2}|\(R\)|\([^)]{1,8}\))$/i.test(campo)) continue;

    for (const parte of campo.split(/\u241D|\s*[;|]\s*/)) {
      const nome = limparPossivelProfessor(parte);
      if (pareceNomeDeProfessor(nome)) nomes.push(nome);
    }
  }

  return normalizarProfessores(nomes);
}

function escolherProfessores(...listas) {
  // Escolhe a lista mais completa. A antiga regra aceitava a primeira lista
  // não vazia, mesmo quando ela continha apenas um docente e a leitura por
  // links, logo depois, tinha todos os nomes.
  const candidatas = listas
    .map((lista, prioridade) => ({
      nomes: normalizarProfessores(lista || []),
      prioridade
    }))
    .filter((item) => item.nomes.length);

  if (!candidatas.length) return [];
  candidatas.sort((a, b) => (
    b.nomes.length - a.nomes.length || a.prioridade - b.prioridade
  ));
  return candidatas[0].nomes;
}

function normalizarProfessores(nomes) {
  const vistos = new Set();
  const resultado = [];

  for (const nomeOriginal of nomes || []) {
    for (const parte of String(nomeOriginal || '').split(/\u241D|\s*[;|]\s*/)) {
      const nome = normalizarTexto(parte)
        .replace(/\b(?:Hor[aá]rio|Prof\.?\(a\)?)\b/gi, '')
        .replace(/^[-–—·,:;]+|[-–—·,:;]+$/g, '')
        .trim();
      if (!pareceNomeDeProfessor(nome)) continue;
      const chave = nome.toLocaleLowerCase('pt-BR');
      if (!vistos.has(chave)) {
        vistos.add(chave);
        resultado.push(nome);
      }
    }
  }

  return resultado;
}

function extrairDias(horario) {
  const dias = Array.from(String(horario).matchAll(/\b(seg|ter|qua|qui|sex|s[aá]b|dom)\b/gi), (item) => item[1].toLowerCase());
  return dias.length ? [...new Set(dias)].join(' / ') : '—';
}

function extrairCategorias(texto) {
  const categorias = [];
const regex = /\b(Obrigat(?:ória| ria)|Optativa\s+Eletiva|Optativa\s+Livre|Alunos\s+Especiais|Extracurricular|Qualquer\s+Unidade(?:\s+da\s+USP)?)\s+(\d+|-)\s+(\d+|-)\s+(-|\d+)\s+(\d+|-)/gi;  for (const encontrado of texto.matchAll(regex)) {
  const vagas = Number(encontrado[2]);
  if (!Number.isFinite(vagas) || vagas <= 0) continue;

  // O Júpiter informa "Inscritos" como o total geral (pendentes + matriculados
  // + aguardando). Somar os três como se fossem disjuntos duplicava a ocupação
  // (ex.: 47 vagas com 47 inscritos e 47 matriculados virava 200% ocupado).
  // Normaliza para "aguardando vaga" para que ocupadas = inscritos + pendentes
  // + matriculados volte a representar pessoas distintas.
  const inscritosBrutos = encontrado[3] === '-' ? 0 : Number(encontrado[3]) || 0;
  const pendentes = encontrado[4] === '-' ? 0 : Number(encontrado[4]) || 0;
  const matriculados = encontrado[5] === '-' ? 0 : Number(encontrado[5]) || 0;
  const inscritos = Math.max(0, inscritosBrutos - pendentes - matriculados);

  categorias.push({
   nome: normalizarTexto(encontrado[1]),
   vagas,
   inscritos,
   pendentes,
   matriculados
});
  }
  return categorias;
}

function substituirDisciplina(disciplinas, nova) {
  const indice = disciplinas.findIndex((disciplina) => disciplina.codigo === nova.codigo);
  if (indice >= 0) disciplinas[indice] = nova;
  else disciplinas.push(nova);
}

function removerDisciplina(disciplinas, codigo) {
  const indice = disciplinas.findIndex((disciplina) => disciplina.codigo === codigo);
  if (indice >= 0) disciplinas.splice(indice, 1);
}

function resumirPessoas(disciplina) {
  const porGrupo = new Map();
  for (const turma of disciplina.turmas || []) {
    const grupo = turma.grupoTurma || turma.codigo;
    if (!porGrupo.has(grupo)) porGrupo.set(grupo, new Map());
    const porCodigo = porGrupo.get(grupo);
    if (!porCodigo.has(turma.codigo)) porCodigo.set(turma.codigo, []);
    porCodigo.get(turma.codigo).push(turma);
  }

  const total = { inscritos: 0, pendentes: 0, matriculados: 0 };
  for (const [grupo, porCodigo] of porGrupo) {
    const principal = porCodigo.get(grupo);
    const candidatas = principal ? [somarRegistros(principal)] : Array.from(porCodigo.values(), somarRegistros);
    const escolhida = candidatas.reduce((maior, atual) => {
      const a = maior.inscritos + maior.pendentes + maior.matriculados;
      const b = atual.inscritos + atual.pendentes + atual.matriculados;
      return b > a ? atual : maior;
    }, { inscritos: 0, pendentes: 0, matriculados: 0 });
    total.inscritos += escolhida.inscritos;
    total.pendentes += escolhida.pendentes;
    total.matriculados += escolhida.matriculados;
  }
  return { ...total, pessoas: total.inscritos + total.pendentes + total.matriculados };
}

function somarRegistros(turmas) {
  return turmas.reduce((soma, turma) => {
    const norm = normalizarContagemTurma(turma);
    return {
      inscritos: soma.inscritos + norm.inscritos,
      pendentes: soma.pendentes + norm.pendentes,
      matriculados: soma.matriculados + norm.matriculados
    };
  }, { inscritos: 0, pendentes: 0, matriculados: 0 });
}

/**
 * O Júpiter informa "Inscritos" como total (pendentes + matriculados +
 * aguardando). Versões antigas do monitor somavam os três como disjuntos,
 * duplicando a ocupação (ex.: 42 inscritos + 42 matriculados em 65 vagas
 * virava 129%). Esta normalização é idempotente: converte dado legado e
 * preserva dado novo, então pode ser aplicada na leitura sem esperar rescan.
 */
function normalizarContagemTurma(turma) {
  const pendentes = Number(turma?.pendentes || 0) || 0;
  const matriculados = Number(turma?.matriculados || 0) || 0;
  const inscritosBrutos = Number(turma?.inscritos || 0) || 0;
  return {
    inscritos: Math.max(0, inscritosBrutos - pendentes - matriculados),
    pendentes,
    matriculados
  };
}

function normalizarTurmaParaResposta(turma) {
  const norm = normalizarContagemTurma(turma);
  const total = Number(turma?.total ?? turma?.vagas ?? 0) || 0;
  const ocupadas = norm.inscritos + norm.pendentes + norm.matriculados;
  return {
    ...turma,
    total,
    ocupadas,
    disponiveis: Math.max(0, total - ocupadas),
    inscritos: norm.inscritos,
    pendentes: norm.pendentes,
    matriculados: norm.matriculados
  };
}

function ordenarDisciplinas(disciplinas) {
  disciplinas.sort((a, b) => resumirPessoas(b).pessoas - resumirPessoas(a).pessoas || a.codigo.localeCompare(b.codigo));
}


/**
 * Ciclo automático de semestres.
 *
 * O Júpiter só mostra as turmas "vivas". Quando o período de consulta pública
 * termina, a página passa a dizer que não existe oferecimento, mesmo com o
 * semestre ainda em andamento; mais tarde aparecem as turmas do semestre
 * seguinte. Para que essas fases não se misturem, cada turma é atribuída a um
 * semestre (pelas datas Início/Fim informadas pelo Júpiter ou pelo código da
 * turma, AAAAS##) e guardada em um compartimento próprio:
 *
 * - ao vivo: a disciplina ainda aparece no Júpiter e é atualizada pelo cron;
 * - congelada: o Júpiter retirou a oferta, mas o semestre ainda não acabou —
 *   o último retrato confirmado continua visível, marcado como congelado;
 * - arquivada: passado o fim do semestre (mais uma carência), o compartimento
 *   inteiro é gravado em uma chave própria do KV e sai da tela principal,
 *   ficando disponível no seletor "Arquivo".
 *
 * Um semestre novo é aberto sozinho na primeira turma encontrada com outro
 * período. Antes disso, o próximo semestre aparece como "aguardando cadastro".
 * Nada aqui depende de configuração manual a cada semestre.
 */
function semestreDeData(dataIso) {
  const achado = String(dataIso || '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!achado) return null;
  return `${achado[1]}-${Number(achado[2]) <= 7 ? 1 : 2}`;
}

function identificarSemestreDaTurma(codigoTurma, inicio) {
  // As datas da própria turma são a fonte mais confiável.
  const porData = semestreDeData(inicio);
  if (porData) return porData;
  // Códigos de turma do Júpiter seguem AAAA + semestre + sequência (ex.: 2026201).
  const achado = String(codigoTurma || '').match(/^(20\d{2})([12])\d{2}$/);
  return achado ? `${achado[1]}-${achado[2]}` : null;
}

function semestreValido(id) { return /^\d{4}-[12]$/.test(String(id || '')); }

function compararSemestres(a, b) { return String(a).localeCompare(String(b)); }

function proximoSemestre(id) {
  const [ano, periodo] = String(id).split('-').map(Number);
  return periodo === 1 ? `${ano}-2` : `${ano + 1}-1`;
}

function rotuloSemestre(id) {
  const [ano, periodo] = String(id).split('-');
  return `${periodo}º semestre de ${ano}`;
}

function limitesCalendarioSemestre(id) {
  // Usado só enquanto o Júpiter ainda não informou as datas reais das turmas.
  const [ano, periodo] = String(id).split('-');
  return periodo === '1'
    ? { inicio: `${ano}-02-01`, fim: `${ano}-07-31` }
    : { inicio: `${ano}-08-01`, fim: `${ano}-12-31` };
}

function limitesDoSemestre(id, disciplinas) {
  let inicio = null;
  let fim = null;
  for (const disciplina of disciplinas || []) {
    for (const turma of disciplina.turmas || []) {
      if (turma.inicio && (!inicio || turma.inicio < inicio)) inicio = turma.inicio;
      if (turma.fim && (!fim || turma.fim > fim)) fim = turma.fim;
    }
  }
  const calendario = limitesCalendarioSemestre(id);
  return {
    inicio: inicio || calendario.inicio,
    fim: fim || calendario.fim,
    fonteDatas: inicio && fim ? 'jupiter' : (inicio || fim ? 'parcial' : 'calendario')
  };
}

function statusDoSemestre(limites, hojeBrt) {
  if (hojeBrt < limites.inicio) return 'proximo';
  if (hojeBrt > limites.fim) return 'encerrado';
  return 'em_andamento';
}

function separarTurmasPorSemestre(disciplina, agora) {
  const grupos = new Map();
  const semSemestre = [];
  for (const turma of disciplina.turmas || []) {
    const semestre = semestreValido(turma.semestre) ? turma.semestre : identificarSemestreDaTurma(turma.codigo, turma.inicio);
    if (!semestre) { semSemestre.push(turma); continue; }
    if (!grupos.has(semestre)) grupos.set(semestre, []);
    grupos.get(semestre).push({ ...turma, semestre });
  }

  if (semSemestre.length) {
    // Turma sem data nem código reconhecível: acompanha as irmãs da mesma
    // disciplina; sem referência, vai para o semestre do calendário.
    const referencia = [...grupos.keys()].sort(compararSemestres).at(-1)
      || semestreDeData(dataBrt(disciplina.atualizadaEm || agora));
    if (!grupos.has(referencia)) grupos.set(referencia, []);
    grupos.get(referencia).push(...semSemestre.map((turma) => ({ ...turma, semestre: referencia })));
  }
  return grupos;
}

function garantirEstruturaSemestral(dados, agora = Date.now()) {
  dados.arquivo ||= [];
  if (dados.semestres && typeof dados.semestres === 'object') return dados;

  // Migração dos dados anteriores ao ciclo semestral: o que estava no monitor
  // é distribuído nos semestres a que cada turma pertence.
  dados.semestres = {};
  for (const disciplina of dados.disciplinas || []) {
    registrarOfertaNosSemestres(dados, disciplina, Number(disciplina.atualizadaEm) || agora, { migracao: true });
  }
  return dados;
}

function registrarOfertaNosSemestres(dados, disciplina, agora, { migracao = false } = {}) {
  dados.semestres ||= {};
  const arquivados = new Set((dados.arquivo || []).map((item) => item.id));
  const grupos = separarTurmasPorSemestre(disciplina, agora);

  for (const [semestre, turmas] of grupos) {
    // Um semestre já arquivado não é reaberto por uma leitura tardia.
    if (arquivados.has(semestre)) continue;
    const compartimento = dados.semestres[semestre] ||= { id: semestre, criadoEm: agora, disciplinas: {} };
    compartimento.atualizadoEm = agora;
    const anterior = compartimento.disciplinas[disciplina.codigo];
    compartimento.disciplinas[disciplina.codigo] = {
      codigo: disciplina.codigo,
      nome: disciplina.nome,
      turmas,
      atualizadaEm: disciplina.atualizadaEm || agora,
      noJupiter: true,
      vistaNoJupiterEm: migracao ? (anterior?.vistaNoJupiterEm || disciplina.atualizadaEm || agora) : agora,
      retiradaDoJupiterEm: null
    };
  }

  // Se a disciplina tinha turmas em outro semestre e elas sumiram do Júpiter,
  // aquele retrato é congelado (não apagado).
  for (const [semestre, compartimento] of Object.entries(dados.semestres)) {
    if (grupos.has(semestre)) continue;
    congelarNoCompartimento(compartimento, disciplina.codigo, agora);
  }
}

function registrarRetiradaNosSemestres(dados, codigo, agora) {
  for (const compartimento of Object.values(dados.semestres || {})) {
    congelarNoCompartimento(compartimento, codigo, agora);
  }
}

function congelarNoCompartimento(compartimento, codigo, agora) {
  const item = compartimento?.disciplinas?.[codigo];
  if (!item || !item.noJupiter) return;
  item.noJupiter = false;
  item.retiradaDoJupiterEm = agora;
  compartimento.atualizadoEm = agora;
}

function aplicarOferta(dados, disciplina, agora) {
  substituirDisciplina(dados.disciplinas, disciplina);
  registrarOfertaNosSemestres(dados, disciplina, agora);
}

function aplicarSemOferta(dados, codigo, agora) {
  removerDisciplina(dados.disciplinas, codigo);
  registrarRetiradaNosSemestres(dados, codigo, agora);
}

/**
 * Executado a cada varredura diária. Arquiva semestres encerrados e descarta
 * compartimentos vazios que já passaram. É idempotente: rodar duas vezes no
 * mesmo dia não muda nada.
 */
async function manterCicloDeSemestres(env, dados, hojeBrt, agora) {
  garantirEstruturaSemestral(dados, agora);

  for (const [id, compartimento] of Object.entries(dados.semestres)) {
    const disciplinas = Object.values(compartimento.disciplinas || {});
    const limites = limitesDoSemestre(id, disciplinas);
    const fimComCarencia = deslocarData(limites.fim, CARENCIA_ARQUIVAMENTO_DIAS);
    const fimForcado = deslocarData(limites.fim, LIMITE_ARQUIVAMENTO_FORCADO_DIAS);
    const aindaNoJupiter = disciplinas.some((disciplina) => disciplina.noJupiter);

    if (!disciplinas.length) {
      if (hojeBrt > fimComCarencia) delete dados.semestres[id];
      continue;
    }

    // Espera o Júpiter retirar a oferta; se ele nunca retirar, arquiva mesmo
    // assim depois de um prazo longo para não acumular semestres na tela.
    if (hojeBrt > fimForcado || (hojeBrt > fimComCarencia && !aindaNoJupiter)) {
      await arquivarSemestre(env, dados, id, compartimento, limites, agora);
    }
  }
}

async function arquivarSemestre(env, dados, id, compartimento, limites, agora) {
  const chave = chaveSemestreArquivado(id);
  const existente = await lerJson(env, chave);
  const porCodigo = new Map((existente?.disciplinas || []).map((disciplina) => [disciplina.codigo, disciplina]));
  for (const disciplina of Object.values(compartimento.disciplinas || {})) {
    porCodigo.set(disciplina.codigo, { ...disciplina, noJupiter: false });
  }

  const disciplinas = [...porCodigo.values()];
  ordenarDisciplinas(disciplinas);
  const limitesFinais = limitesDoSemestre(id, disciplinas);
  const registro = {
    versao: 1,
    id,
    rotulo: rotuloSemestre(id),
    inicio: limitesFinais.inicio || limites.inicio,
    fim: limitesFinais.fim || limites.fim,
    fonteDatas: limitesFinais.fonteDatas,
    arquivadoEm: existente?.arquivadoEm || agora,
    atualizadoEm: agora,
    disciplinas
  };

  // Grava primeiro o arquivo; só depois remove o semestre da área ativa.
  await env.PNV_MONITOR.put(chave, JSON.stringify(registro));

  dados.arquivo = (dados.arquivo || []).filter((item) => item.id !== id);
  dados.arquivo.push({
    id,
    rotulo: registro.rotulo,
    inicio: registro.inicio,
    fim: registro.fim,
    fonteDatas: registro.fonteDatas,
    arquivadoEm: registro.arquivadoEm,
    totalDisciplinas: disciplinas.length,
    totalTurmas: contarTurmas(disciplinas)
  });
  dados.arquivo.sort((a, b) => compararSemestres(b.id, a.id));
  delete dados.semestres[id];
}

function contarTurmas(disciplinas) {
  const codigos = new Set();
  for (const disciplina of disciplinas || []) {
    for (const turma of disciplina.turmas || []) codigos.add(`${disciplina.codigo}|${turma.codigo}`);
  }
  return codigos.size;
}

function chaveSemestreArquivado(id) { return `${PREFIXO_SEMESTRE_ARQUIVADO}${id}`; }

/** Lista de semestres exibida no site: ativos, próximo (placeholder) e arquivo. */
function listarSemestres(dados, hojeBrt) {
  const arquivados = new Set((dados.arquivo || []).map((item) => item.id));
  const ativos = new Map(Object.entries(dados.semestres || {}));

  const calendarioAtual = semestreDeData(hojeBrt);
  if (!ativos.has(calendarioAtual) && !arquivados.has(calendarioAtual)) {
    ativos.set(calendarioAtual, { id: calendarioAtual, disciplinas: {}, placeholder: true });
  }

  // Abre o próximo semestre na tela assim que o atual se aproxima do fim,
  // mesmo que o Júpiter ainda não tenha nenhuma turma cadastrada.
  // A referência considera também o arquivo e o calendário: entre semestres,
  // quando tudo já foi arquivado, o seguinte continua aparecendo.
  const maisRecente = [...ativos.keys(), ...arquivados, calendarioAtual].filter(semestreValido).sort(compararSemestres).at(-1);
  if (maisRecente) {
    const disciplinasReferencia = Object.values(ativos.get(maisRecente)?.disciplinas || {});
    const limites = limitesDoSemestre(maisRecente, disciplinasReferencia);
    const seguinte = proximoSemestre(maisRecente);
    const referenciaEncerrada = arquivados.has(maisRecente) || hojeBrt > limites.fim;
    if ((referenciaEncerrada || hojeBrt >= deslocarData(limites.fim, -ANTECEDENCIA_PROXIMO_SEMESTRE_DIAS)) && !arquivados.has(seguinte)) {
      ativos.set(seguinte, { id: seguinte, disciplinas: {}, placeholder: true });
    }
  }

  const lista = [...ativos.entries()].sort(([a], [b]) => compararSemestres(a, b)).map(([id, compartimento]) => {
    const disciplinas = Object.values(compartimento.disciplinas || {});
    const limites = limitesDoSemestre(id, disciplinas);
    const noJupiter = disciplinas.filter((disciplina) => disciplina.noJupiter).length;
    const situacao = !disciplinas.length ? 'aguardando'
      : noJupiter === disciplinas.length ? 'ao_vivo'
      : noJupiter ? 'parcial' : 'congelado';
    const retiradas = disciplinas.map((disciplina) => Number(disciplina.retiradaDoJupiterEm) || 0).filter(Boolean);
    const status = statusDoSemestre(limites, hojeBrt);
    return {
      id,
      rotulo: rotuloSemestre(id),
      inicio: limites.inicio,
      fim: limites.fim,
      fonteDatas: limites.fonteDatas,
      status,
      situacao,
      arquivado: false,
      totalDisciplinas: disciplinas.length,
      disciplinasNoJupiter: noJupiter,
      totalTurmas: contarTurmas(disciplinas),
      congeladoEm: situacao === 'congelado' && retiradas.length ? Math.max(...retiradas) : null,
      arquivamentoPrevistoEm: deslocarData(limites.fim, CARENCIA_ARQUIVAMENTO_DIAS)
    };
  });

  const arquivo = [...(dados.arquivo || [])]
    .sort((a, b) => compararSemestres(b.id, a.id))
    .map((item) => ({ ...item, rotulo: item.rotulo || rotuloSemestre(item.id), status: 'encerrado', situacao: 'arquivado', arquivado: true }));

  return { ativos: lista, arquivo };
}

function escolherSemestrePadrao(ativos) {
  const comDados = ativos.filter((item) => item.totalDisciplinas);
  // 1) o semestre mais novo com turmas vivas no Júpiter (ex.: período de matrícula);
  const aoVivo = comDados.filter((item) => item.disciplinasNoJupiter).at(-1);
  if (aoVivo) return aoVivo.id;
  // 2) o semestre em andamento, mesmo congelado;
  const emAndamento = comDados.find((item) => item.status === 'em_andamento');
  if (emAndamento) return emAndamento.id;
  // 3) o mais recente com dados; 4) o primeiro da lista.
  return comDados.at(-1)?.id || ativos.find((item) => item.status !== 'encerrado')?.id || ativos.at(-1)?.id || null;
}

function turmasDoSemestreMaisRecente(disciplina) {
  const grupos = separarTurmasPorSemestre(disciplina, Date.now());
  const maisRecente = [...grupos.keys()].sort(compararSemestres).at(-1);
  return maisRecente ? grupos.get(maisRecente) : (disciplina.turmas || []);
}

/**
 * Histórico diário sem prazo fixo de retenção.
 *
 * O histórico anterior (V1) ficava inteiro em uma única chave e era limitado a
 * 366 dias. A V2 divide os dados em chaves mensais. Cada mês continua usando
 * segmentos compactados: dias consecutivos com o mesmo estado ocupam somente
 * um segmento. Isso mantém o detalhe diário disponível sem crescer por dia de
 * forma desnecessária.
 *
 * O Workers KV não informa o uso total do namespace diretamente ao Worker. Por
 * isso, o índice mede os bytes escritos pelo próprio histórico e começa a
 * apagar somente os meses mais antigos ao ultrapassar uma reserva conservadora.
 * Se o KV ainda responder erro de capacidade, o código remove meses adicionais,
 * um a um, até a gravação voltar a caber.
 */
async function registrarSnapshotDiario(env, dados, full, agora) {
  const data = full?.data || dataBrt(agora);
  const confirmadas = full?.confirmadas || {};
  const codigos = Array.isArray(full?.codigos) && full.codigos.length
    ? full.codigos
    : Object.keys(confirmadas);

  if (!codigos.length) return;

  const indice = await migrarHistoricoLegadoSeNecessario(env);
  const mes = data.slice(0, 7);
  const historicoMes = await lerHistoricoMes(env, mes);
  historicoMes.cursos ||= {};
  historicoMes.mes = mes;

  indice.ultimaData = data;
  indice.atualizadoEm = agora;

  const disciplinasPorCodigo = new Map((dados.disciplinas || []).map((disciplina) => [disciplina.codigo, disciplina]));

  for (const codigo of codigos) {
    // Falha transitória não deve virar zero no gráfico. O dia fica sem leitura
    // confirmada, preservando a integridade da série histórica.
    const situacao = confirmadas[codigo];
    if (!situacao) continue;

    const disciplina = disciplinasPorCodigo.get(codigo);
    const cursoMes = historicoMes.cursos[codigo] ||= { nome: disciplina?.nome || codigo, segmentos: [] };
    if (disciplina?.nome) cursoMes.nome = disciplina.nome;

    const cursoIndice = indice.cursos[codigo] ||= { nome: disciplina?.nome || codigo, meses: [] };
    if (disciplina?.nome) cursoIndice.nome = disciplina.nome;
    if (!cursoIndice.meses.includes(mes)) cursoIndice.meses.push(mes);
    cursoIndice.meses.sort();

    let estado;
    if (situacao === 'ofertada' && disciplina) {
      // Se o Júpiter exibir dois semestres ao mesmo tempo, o histórico diário
      // acompanha o mais novo em vez de somar turmas de períodos diferentes.
      const pessoas = resumirPessoas({ ...disciplina, turmas: turmasDoSemestreMaisRecente(disciplina) });
      estado = {
        ofertada: true,
        inscritos: pessoas.inscritos,
        pendentes: pessoas.pendentes,
        matriculados: pessoas.matriculados
      };
    } else if (situacao === 'sem_oferta') {
      estado = { ofertada: false, inscritos: 0, pendentes: 0, matriculados: 0 };
    } else {
      continue;
    }

    inserirEstadoNoHistorico(cursoMes.segmentos, data, estado);
  }

  await salvarHistoricoMensal(env, indice, mes, historicoMes);
}

function inserirEstadoNoHistorico(segmentos, data, estado) {
  const normalizados = Array.isArray(segmentos) ? segmentos : [];
  const indice = normalizados.findIndex((segmento) => segmento.inicio <= data && data <= segmento.fim);

  if (indice >= 0) {
    const atual = normalizados[indice];
    if (estadosHistoricosIguais(atual, estado)) return;

    const substitutos = [];
    if (atual.inicio < data) {
      substitutos.push({ ...extrairEstadoHistorico(atual), inicio: atual.inicio, fim: diaAnterior(data) });
    }
    substitutos.push({ ...estado, inicio: data, fim: data });
    if (atual.fim > data) {
      substitutos.push({ ...extrairEstadoHistorico(atual), inicio: diaSeguinte(data), fim: atual.fim });
    }
    normalizados.splice(indice, 1, ...substitutos);
  } else {
    normalizados.push({ ...estado, inicio: data, fim: data });
  }

  normalizados.sort((a, b) => a.inicio.localeCompare(b.inicio));
  mesclarSegmentosHistoricos(normalizados);
}

function extrairEstadoHistorico(segmento) {
  return {
    ofertada: Boolean(segmento.ofertada),
    inscritos: Number(segmento.inscritos || 0),
    pendentes: Number(segmento.pendentes || 0),
    matriculados: Number(segmento.matriculados || 0)
  };
}

function estadosHistoricosIguais(segmento, estado) {
  const a = extrairEstadoHistorico(segmento);
  const b = {
    ofertada: Boolean(estado.ofertada),
    inscritos: Number(estado.inscritos || 0),
    pendentes: Number(estado.pendentes || 0),
    matriculados: Number(estado.matriculados || 0)
  };
  return a.ofertada === b.ofertada && a.inscritos === b.inscritos && a.pendentes === b.pendentes && a.matriculados === b.matriculados;
}

function mesclarSegmentosHistoricos(segmentos) {
  for (let indice = segmentos.length - 1; indice > 0; indice -= 1) {
    const anterior = segmentos[indice - 1];
    const atual = segmentos[indice];
    if (diaSeguinte(anterior.fim) === atual.inicio && estadosHistoricosIguais(anterior, atual)) {
      anterior.fim = atual.fim;
      segmentos.splice(indice, 1);
    }
  }
}

async function migrarHistoricoLegadoSeNecessario(env) {
  const indiceExistente = await lerIndiceHistorico(env);
  if (indiceExistente.migracaoLegadoConcluida) return indiceExistente;

  const legado = await lerJson(env, KEY_HISTORICO_LEGADO);
  if (!legado?.cursos || !Object.keys(legado.cursos).length) {
    indiceExistente.migracaoLegadoConcluida = true;
    await salvarIndiceHistorico(env, indiceExistente);
    return indiceExistente;
  }

  const meses = new Map();
  const indice = indiceExistente;
  indice.cursos ||= {};
  indice.meses ||= {};

  for (const [codigo, cursoLegado] of Object.entries(legado.cursos || {})) {
    const cursoIndice = indice.cursos[codigo] ||= { nome: cursoLegado.nome || codigo, meses: [] };
    if (cursoLegado.nome) cursoIndice.nome = cursoLegado.nome;

    for (const segmentoLegado of cursoLegado.segmentos || []) {
      const estado = extrairEstadoHistorico(segmentoLegado);
      let cursor = segmentoLegado.inicio;
      while (cursor && cursor <= segmentoLegado.fim) {
        const mes = cursor.slice(0, 7);
        const fimParte = menorData(segmentoLegado.fim, ultimoDiaDoMes(cursor));
        if (!meses.has(mes)) meses.set(mes, await lerHistoricoMes(env, mes));
        const historicoMes = meses.get(mes);
        historicoMes.cursos ||= {};
        historicoMes.mes = mes;
        const cursoMes = historicoMes.cursos[codigo] ||= { nome: cursoLegado.nome || codigo, segmentos: [] };
        if (cursoLegado.nome) cursoMes.nome = cursoLegado.nome;
        cursoMes.segmentos.push({ ...estado, inicio: cursor, fim: fimParte });
        if (!cursoIndice.meses.includes(mes)) cursoIndice.meses.push(mes);
        cursor = diaSeguinte(fimParte);
      }
    }
  }

  for (const [mes, historicoMes] of meses) {
    for (const curso of Object.values(historicoMes.cursos || {})) {
      curso.segmentos.sort((a, b) => a.inicio.localeCompare(b.inicio));
      mesclarSegmentosHistoricos(curso.segmentos);
    }
    await prepararMesNoIndice(indice, mes, historicoMes);
    await env.PNV_MONITOR.put(chaveHistoricoMes(mes), JSON.stringify(historicoMes));
  }

  for (const curso of Object.values(indice.cursos)) curso.meses.sort();
  indice.ultimaData = legado.ultimaData || indice.ultimaData || null;
  indice.atualizadoEm = Date.now();
  indice.migracaoLegadoConcluida = true;
  await aplicarRetencaoPorCapacidade(env, indice);
  await salvarIndiceHistorico(env, indice);
  await env.PNV_MONITOR.delete(KEY_HISTORICO_LEGADO);
  return indice;
}

async function salvarHistoricoMensal(env, indice, mes, historicoMes) {
  const serializado = JSON.stringify(historicoMes);
  const tamanho = tamanhoUtf8(serializado);
  if (tamanho > LIMITE_VALOR_HISTORICO_BYTES) {
    throw new Error(`O histórico de ${mes} ultrapassou o limite individual de armazenamento.`, { cause: null });
  }

  await prepararMesNoIndice(indice, mes, historicoMes, tamanho);
  await aplicarRetencaoPorCapacidade(env, indice, new Set([mes]));

  try {
    await gravarHistoricoComRecuperacao(env, indice, mes, serializado);
    await salvarIndiceHistorico(env, indice);
  } catch (erro) {
    throw erro;
  }
}

async function gravarHistoricoComRecuperacao(env, indice, mes, serializado) {
  try {
    await env.PNV_MONITOR.put(chaveHistoricoMes(mes), serializado);
    return;
  } catch (erroInicial) {
    if (!erroPareceCapacidade(erroInicial)) throw erroInicial;

    // Caso o uso real do namespace seja maior do que a estimativa local,
    // libera os meses mais antigos, um a um, e tenta novamente. Nunca toca no
    // mês em gravação nem em registros recentes por uma simples alteração de código.
    for (let tentativa = 0; tentativa < 60; tentativa += 1) {
      const removeu = await removerMesesAntigos(env, indice, new Set([mes]), 1);
      if (!removeu) throw erroInicial;
      try {
        await env.PNV_MONITOR.put(chaveHistoricoMes(mes), serializado);
        return;
      } catch (erroSeguinte) {
        if (!erroPareceCapacidade(erroSeguinte)) throw erroSeguinte;
      }
    }

    throw new Error('Não foi possível liberar espaço suficiente para gravar o histórico diário.');
  }
}

async function prepararMesNoIndice(indice, mes, historicoMes, tamanhoConhecido = null) {
  const serializado = tamanhoConhecido === null ? JSON.stringify(historicoMes) : null;
  const bytes = tamanhoConhecido ?? tamanhoUtf8(serializado);
  indice.meses ||= {};
  indice.meses[mes] = {
    bytes,
    primeiraData: primeiraDataDoMes(historicoMes) || `${mes}-01`,
    ultimaData: ultimaDataDoMes(historicoMes) || ultimoDiaDoMes(`${mes}-01`)
  };
  recalcularBytesEstimados(indice);
}

async function aplicarRetencaoPorCapacidade(env, indice, protegidos = new Set()) {
  // A retenção não tem prazo em dias/anos. Só começa quando a estimativa
  // ultrapassa a reserva e então volta para uma faixa segura, removendo sempre
  // meses completos e mais antigos primeiro.
  if (Number(indice.bytesEstimados || 0) <= LIMITE_HISTORICO_BYTES) return;

  while (Number(indice.bytesEstimados || 0) > ALVO_HISTORICO_BYTES) {
    const removido = await removerMesesAntigos(env, indice, protegidos, 1);
    if (!removido) break;
  }
}

async function removerMesesAntigos(env, indice, protegidos = new Set(), quantidade = 1) {
  const candidatos = Object.keys(indice.meses || {})
    .filter((mes) => !protegidos.has(mes))
    .sort();
  if (!candidatos.length) return false;

  let removeu = false;
  for (const mes of candidatos.slice(0, quantidade)) {
    await env.PNV_MONITOR.delete(chaveHistoricoMes(mes));
    delete indice.meses[mes];
    for (const [codigo, curso] of Object.entries(indice.cursos || {})) {
      curso.meses = (curso.meses || []).filter((item) => item !== mes);
      if (!curso.meses.length) delete indice.cursos[codigo];
    }
    removeu = true;
  }
  recalcularBytesEstimados(indice);
  return removeu;
}

function recalcularBytesEstimados(indice) {
  indice.bytesEstimados = Object.values(indice.meses || {}).reduce((soma, meta) => soma + Number(meta.bytes || 0), 0);
}

function chaveHistoricoMes(mes) { return `${PREFIXO_HISTORICO_MES}${mes}`; }
function tamanhoUtf8(texto) { return new TextEncoder().encode(texto).byteLength; }
function menorData(a, b) { return a < b ? a : b; }
function primeiroDiaDoMes(data) { return `${String(data).slice(0, 7)}-01`; }
function ultimoDiaDoMes(data) {
  const dataBase = new Date(`${String(data).slice(0, 7)}-01T00:00:00Z`);
  dataBase.setUTCMonth(dataBase.getUTCMonth() + 1, 0);
  return dataBase.toISOString().slice(0, 10);
}
function primeiraDataDoMes(historicoMes) {
  let menor = null;
  for (const curso of Object.values(historicoMes.cursos || {})) {
    for (const segmento of curso.segmentos || []) if (!menor || segmento.inicio < menor) menor = segmento.inicio;
  }
  return menor;
}
function ultimaDataDoMes(historicoMes) {
  let maior = null;
  for (const curso of Object.values(historicoMes.cursos || {})) {
    for (const segmento of curso.segmentos || []) if (!maior || segmento.fim > maior) maior = segmento.fim;
  }
  return maior;
}
function erroPareceCapacidade(erro) {
  const mensagem = String(erro?.message || erro || '').toLowerCase();
  return /quota|capacity|storage|limit|exceed|too large/.test(mensagem);
}

async function responderHistorico(url, env) {
  const indice = await lerIndiceHistorico(env);
  const codigo = String(url.searchParams.get('codigo') || '').trim().toUpperCase();

  if (!codigo) {
    const catalogo = Object.entries(indice.cursos || {})
      .filter(([, curso]) => Array.isArray(curso.meses) && curso.meses.length)
      .map(([itemCodigo, curso]) => ({ codigo: itemCodigo, nome: curso.nome || itemCodigo }))
      .sort((a, b) => a.codigo.localeCompare(b.codigo));
    return {
      catalogo,
      ultimaData: indice.ultimaData || null,
      atualizadoEm: indice.atualizadoEm || null,
      retencao: {
        semPrazoFixo: true,
        bytesEstimados: Number(indice.bytesEstimados || 0),
        limiteBytes: LIMITE_HISTORICO_BYTES,
        alvoBytes: ALVO_HISTORICO_BYTES
      }
    };
  }

  if (!/^PNV\d{4}$/.test(codigo)) {
    return { codigo, erro: 'Código de disciplina inválido.', serie: [] };
  }

  const cursoIndice = indice.cursos?.[codigo];
  if (!cursoIndice?.meses?.length) {
    return { codigo, nome: codigo, ultimaData: indice.ultimaData || null, serie: [] };
  }

  const diasParametro = String(url.searchParams.get('dias') || '').trim().toLowerCase();
  const todoHistorico = diasParametro === 'todo' || diasParametro === 'tudo';
  const diasSolicitados = todoHistorico
    ? null
    : limitarNumero(diasParametro, 365, 30, Number.MAX_SAFE_INTEGER);
  const fim = indice.ultimaData || dataBrt(Date.now());
  const mesesDoCurso = [...cursoIndice.meses].sort();
  const primeiroMes = mesesDoCurso[0];
  const primeiraData = primeiroMes ? `${primeiroMes}-01` : null;
  const inicioSolicitado = todoHistorico
    ? primeiraData
    : deslocarData(fim, -(diasSolicitados - 1));
  const inicio = primeiraData && inicioSolicitado && primeiraData > inicioSolicitado ? primeiraData : inicioSolicitado;
  const mesesNecessarios = mesesEntre(inicio, fim).filter((mes) => mesesDoCurso.includes(mes));
  const historicosMensais = await Promise.all(mesesNecessarios.map((mes) => lerHistoricoMes(env, mes)));
  const segmentos = historicosMensais.flatMap((historicoMes) => historicoMes.cursos?.[codigo]?.segmentos || []);
  const serie = expandirHistorico(segmentos, inicio, fim);

  return {
    codigo,
    nome: cursoIndice.nome || codigo,
    inicio,
    fim,
    primeiraData,
    ultimaData: indice.ultimaData || null,
    serie
  };
}

function mesesEntre(inicio, fim) {
  const meses = [];
  let cursor = primeiroDiaDoMes(inicio);
  const ultimo = primeiroDiaDoMes(fim);
  while (cursor <= ultimo) {
    meses.push(cursor.slice(0, 7));
    const data = new Date(`${cursor}T00:00:00Z`);
    data.setUTCMonth(data.getUTCMonth() + 1);
    cursor = data.toISOString().slice(0, 10);
  }
  return meses;
}

function expandirHistorico(segmentos, inicio, fim) {
  const ordenados = [...segmentos].sort((a, b) => a.inicio.localeCompare(b.inicio));
  const serie = [];
  for (let data = inicio; data <= fim; data = diaSeguinte(data)) {
    const segmento = ordenados.find((item) => item.inicio <= data && data <= item.fim);
    if (!segmento) {
      serie.push({ data, ofertada: null, inscritos: null, pendentes: null, matriculados: null, pessoas: null });
      continue;
    }
    const norm = normalizarContagemTurma(segmento);
    serie.push({
      data,
      ofertada: Boolean(segmento.ofertada),
      inscritos: norm.inscritos,
      pendentes: norm.pendentes,
      matriculados: norm.matriculados,
      pessoas: norm.inscritos + norm.pendentes + norm.matriculados
    });
  }
  return serie;
}

function deslocarData(data, quantidade) {
  const valor = new Date(`${data}T00:00:00Z`);
  valor.setUTCDate(valor.getUTCDate() + quantidade);
  return valor.toISOString().slice(0, 10);
}

function diaAnterior(data) { return deslocarData(data, -1); }
function diaSeguinte(data) { return deslocarData(data, 1); }
function limitarNumero(valor, padrao, minimo, maximo) {
  const numero = Number.parseInt(valor, 10);
  return Number.isFinite(numero) ? Math.max(minimo, Math.min(maximo, numero)) : padrao;
}

async function lerIndiceHistorico(env) {
  return (await lerJson(env, KEY_HISTORICO_INDICE)) || {
    versao: 2,
    cursos: {},
    meses: {},
    ultimaData: null,
    atualizadoEm: null,
    bytesEstimados: 0,
    migracaoLegadoConcluida: false
  };
}

async function lerHistoricoMes(env, mes) {
  return (await lerJson(env, chaveHistoricoMes(mes))) || { versao: 2, mes, cursos: {} };
}

function salvarIndiceHistorico(env, indice) {
  recalcularBytesEstimados(indice);
  return env.PNV_MONITOR.put(KEY_HISTORICO_INDICE, JSON.stringify(indice));
}

async function montarResposta(dados, estado, env, semestreSolicitado = null) {
  const agora = Date.now();
  const hojeBrt = dataBrt(agora);
  const { ativos, arquivo } = listarSemestres(dados, hojeBrt);
  const semestrePadrao = escolherSemestrePadrao(ativos);
  const pedido = semestreValido(semestreSolicitado) ? semestreSolicitado : null;

  let semestre = ativos.find((item) => item.id === (pedido || semestrePadrao))
    || arquivo.find((item) => item.id === pedido)
    || ativos.find((item) => item.id === semestrePadrao)
    || null;

  let base = [];
  if (semestre?.arquivado) {
    const registro = await lerJson(env, chaveSemestreArquivado(semestre.id));
    base = registro?.disciplinas || [];
  } else if (semestre) {
    base = Object.values(dados.semestres?.[semestre.id]?.disciplinas || {});
  }

  // Normaliza na leitura para corrigir imediatamente registros legados com
  // inscritos duplicados, sem esperar a próxima varredura completa do cron.
  const disciplinas = base.map((disciplina) => ({
    ...disciplina,
    turmas: (disciplina.turmas || []).map(normalizarTurmaParaResposta)
  }));
  ordenarDisciplinas(disciplinas);
  return {
    disciplinas,
    semestre,
    semestrePadrao,
    semestres: ativos,
    arquivo,
    desativadas: [...(dados.desativadas || [])].sort((a, b) => String(b.desativacao || '').localeCompare(String(a.desativacao || '')) || a.codigo.localeCompare(b.codigo)),
    curriculo: dados.curriculo || { versao: 1, atualizadoEm: null, porCodigo: {}, fontes: [] },
    meta: {
      geradoEm: agora,
      ultimaAtualizacao: dados.ultimaAtualizacao || null,
      ultimaAtualizacaoCurta: dados.ultimaAtualizacaoCurta || null,
      ultimaConsultaCompleta: dados.ultimaConsultaCompleta || null,
      ultimaListaPNV: dados.ultimaListaPNV || null,
      disciplinasDesativadas: (dados.desativadas || []).length,
      ultimoErro: dados.ultimoErro || null,
      proximaAtualizacaoCurta: proximoMultiploDeCincoMinutos(agora),
      // Sem nenhuma turma viva no Júpiter, a atualização curta varre a lista
      // oficial completa à procura das turmas do próximo semestre.
      atualizacaoCurtaModo: (dados.disciplinas || []).length ? 'ofertadas' : 'procurando_novas_turmas',
      disciplinasNoJupiter: (dados.disciplinas || []).length,
      proximaConsultaCompleta: proximaMeiaNoiteBrt(agora),
      inicializacaoEmAndamento: false,
      fullScan: estado.full ? {
        emAndamento: Boolean(estado.full.emAndamento),
        data: estado.full.data,
        total: estado.full.total || 0,
        concluidas: estado.full.concluidas || 0,
        comTurmas: estado.full.comTurmas || 0,
        semOferta: estado.full.semOferta || 0,
        falhas: estado.full.falhas || 0,
        historicoRegistradoEm: estado.full.historicoRegistradoEm || null,
        iniciadoEm: estado.full.iniciadoEm || null,
        concluidoEm: estado.full.concluidoEm || null
      } : null
    }
  };
}

async function lerHistorico(env) {
  return (await lerJson(env, KEY_HISTORICO)) || { versao: 1, cursos: {}, ultimaData: null, atualizadoEm: null };
}

function salvarHistorico(env, historico) {
  return env.PNV_MONITOR.put(KEY_HISTORICO, JSON.stringify(historico));
}

async function lerDados(env) {
  const dados = (await lerJson(env, KEY_DADOS)) || {
    disciplinas: [],
    desativadas: [],
    curriculo: { versao: 1, atualizadoEm: null, porCodigo: {}, fontes: [] },
    ultimaAtualizacao: null,
    ultimoErro: null
  };
  dados.disciplinas ||= [];
  return garantirEstruturaSemestral(dados);
}

async function lerEstado(env) {
  return (await lerJson(env, KEY_ESTADO)) || { full: null, cursorCurto: 0 };
}

async function lerJson(env, chave) {
  const valor = await env.PNV_MONITOR.get(chave);
  if (!valor) return null;
  try { return JSON.parse(valor); } catch { return null; }
}

function salvarDados(env, dados) { return env.PNV_MONITOR.put(KEY_DADOS, JSON.stringify(dados)); }
function salvarEstado(env, estado) { return env.PNV_MONITOR.put(KEY_ESTADO, JSON.stringify(estado)); }

function respostaJson(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0'
    }
  });
}

function dataBrt(instante) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(instante));
  const valor = (tipo) => partes.find((parte) => parte.type === tipo)?.value;
  return `${valor('year')}-${valor('month')}-${valor('day')}`;
}

function proximoMultiploDeCincoMinutos(instante) {
  const proximo = new Date(instante);
  proximo.setUTCSeconds(0, 0);
  const minuto = proximo.getUTCMinutes();
  proximo.setUTCMinutes(minuto + (5 - (minuto % 5)));
  return proximo.getTime();
}

function partesNoFuso(instante) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(instante));
  const valor = (tipo) => Number(partes.find((parte) => parte.type === tipo)?.value);
  return { ano: valor('year'), mes: valor('month'), dia: valor('day'), hora: valor('hour'), minuto: valor('minute') };
}

function dataHoraNoFusoParaUtc(ano, mes, dia, hora, minuto) {
  // Converte uma hora civil de America/Sao_Paulo para UTC sem depender de um
  // deslocamento fixo. Isso mantém o agendamento correto caso a regra de fuso mude.
  const desejado = Date.UTC(ano, mes - 1, dia, hora, minuto, 0);
  let palpite = desejado;
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    const atual = partesNoFuso(palpite);
    const atualComoUtc = Date.UTC(atual.ano, atual.mes - 1, atual.dia, atual.hora, atual.minuto, 0);
    palpite += desejado - atualComoUtc;
  }
  return palpite;
}

function proximaMeiaNoiteBrt(instante) {
  const agora = partesNoFuso(instante);
  const amanha = new Date(Date.UTC(agora.ano, agora.mes - 1, agora.dia) + 24 * 60 * 60 * 1000);
  return dataHoraNoFusoParaUtc(amanha.getUTCFullYear(), amanha.getUTCMonth() + 1, amanha.getUTCDate(), 0, 0);
}

function normalizarTexto(valor) { return String(valor || '').replace(/\s+/g, ' ').trim(); }
function mensagemErro(erro) { return String(erro?.message || erro || 'Erro desconhecido').slice(0, 250); }
function dormir(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
