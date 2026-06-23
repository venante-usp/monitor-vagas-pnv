/**
 * Monitor de vagas PNV — Cloudflare Workers Free (V8: histórico detalhado)
 *
 * - Interface estática servida pelo próprio Worker.
 * - Dados ficam no Workers KV.
 * - Um Cron a cada 5 min executa as atualizações no servidor.
 * - A varredura completa começa à 00:00 de America/Sao_Paulo e é dividida
 *   em lotes para respeitar o teto gratuito de subrequisições externas.
 */

const URL_LISTA_PNV = 'https://uspdigital.usp.br/jupiterweb/jupDisciplinaLista?codcg=3&pfxdisval=PNV&tipo=D';
const URL_TURMA = 'https://uspdigital.usp.br/jupiterweb/obterTurma?sgldis=';

const KEY_DADOS = 'monitor:latest';
const KEY_ESTADO = 'monitor:state';
const KEY_HISTORICO = 'monitor:history:v1';
const DIAS_HISTORICO = 366;
const ROTA_SINCRONIZAR_APOS_DEPLOY = '/internal/sincronizar-apos-deploy';

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
      return respostaJson(montarResposta(dados, estado));
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
  const lista = await buscarListaAtual();
  if (!lista.ok) throw new Error(`Não foi possível ler a lista PNV: ${lista.erro}`);

  await prepararScanCompleto(env, dados, estado, lista.codigos, hojeBrt, agora);

  if (processarPrimeiroLote) {
    await processarLoteCompleto(env, dados, estado, agora);
  }
}

async function prepararScanCompleto(env, dados, estado, codigos, hojeBrt, agora) {
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
    aplicarResultadoNoScan(dados, full, tarefa, resultado);
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

function aplicarResultadoNoScan(dados, full, tarefa, resultado) {
  if (resultado.tipo === 'ofertada') {
    substituirDisciplina(dados.disciplinas, resultado.disciplina);
    full.confirmadas ||= {};
    full.confirmadas[tarefa.codigo] = 'ofertada';
    full.concluidas += 1;
    full.comTurmas += 1;
    return;
  }

  if (resultado.tipo === 'sem_oferta') {
    removerDisciplina(dados.disciplinas, tarefa.codigo);
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
  const codigos = (dados.disciplinas || []).map((disciplina) => disciplina.codigo);
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
      substituirDisciplina(dados.disciplinas, resultado.disciplina);
    } else if (resultado.tipo === 'sem_oferta') {
      removerDisciplina(dados.disciplinas, resultado.codigo);
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

async function buscarListaAtual() {
  const resposta = await buscarTexto(URL_LISTA_PNV);
  if (!resposta.ok) return { ok: false, erro: resposta.erro };

  const codigos = [...new Set(Array.from(textoDaPagina(resposta.html).matchAll(/\bPNV\s*(\d{4})\b/gi), (item) => `PNV${item[1]}`))];
  return codigos.length ? { ok: true, codigos } : { ok: false, erro: 'A lista não continha códigos PNV reconhecíveis.' };
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
  if (!paginaConfirmaDisciplina(texto, codigo)) {
    return { codigo, tipo: 'transitorio', erro: 'Resposta intermediária ou incompleta.' };
  }

  const turmas = extrairTurmas(texto, textoEstruturado);
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
    // “�”. Por isso lemos os bytes e escolhemos a decodificação mais plausível.
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

function paginaIndicaCodigoDeTurma(texto) {
  return /C(?:[oó]|�)digo\s+da\s+Turma\s*:\s*\d+/i.test(texto);
}

function paginaConfirmaSemOferta(texto) {
  return /Lista\s+de\s+Turmas\s+oferecidas/i.test(texto)
    && !paginaIndicaCodigoDeTurma(texto);
}

function extrairNome(texto, codigo) {
  const padrao = new RegExp(`Disciplina\\s*:\\s*(${codigo}\\s*[-–]\\s*.*?)\\s*(?:Clique\\s+para|Lista\\s+de\\s+Turmas|C(?:[oó]|�)digo\\s+da\\s+Turma|$)`, 'i');
  return normalizarTexto(texto.match(padrao)?.[1] || `Disciplina ${codigo}`);
}

function extrairTurmas(texto, textoEstruturado = '') {
  const marcador = /C(?:[oó]|�)digo\s+da\s+Turma\s*:\s*(\d+)/gi;
  const ocorrencias = Array.from(texto.matchAll(marcador));
  const professoresPorTurma = extrairProfessoresPorTurma(textoEstruturado);
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
    const professores = professoresPorTurma.get(codigo) || extrairProfessoresDoTextoPlano(antesDasVagas);
    const tipo = extrairTipoTurma(antesDasVagas);
    const teoricaVinculada = extrairTurmaTeoricaVinculada(antesDasVagas);

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
  return texto.match(/C(?:[oó]|�)digo\s+da\s+Turma\s+Te(?:[oó]|�)rica\s*:\s*(\d+)/i)?.[1] || null;
}

function extrairHorario(texto) {
  const achado = texto.match(/Hor[aá]rio\s*(?:Prof\.?\(a\)\.?\s*)?(.*)$/i);
  const bruto = normalizarTexto(achado?.[1] || '');
  const limite = bruto.search(/\b(?:Vagas|Prof\.?\(a\)?)\b/i);
  const base = limite >= 0 ? bruto.slice(0, limite) : bruto;
  const horario = base.match(/(?:(?:seg|ter|qua|qui|sex|s[aá]b|dom)\s+\d{1,2}:\d{2}\s+\d{1,2}:\d{2}(?:\s*\([^)]*\))?\s*)+/i)?.[0];
  return normalizarTexto(horario || base) || 'Horário não informado';
}


function extrairProfessoresPorTurma(textoEstruturado) {
  const estrutura = String(textoEstruturado || '');
  if (!estrutura) return new Map();

  const marcador = /C(?:[oó]|�)digo\s+da\s+Turma\s*:\s*(\d+)/gi;
  const ocorrencias = Array.from(estrutura.matchAll(marcador));
  const resultado = new Map();

  for (let indice = 0; indice < ocorrencias.length; indice += 1) {
    const inicio = ocorrencias[indice].index || 0;
    const fim = indice + 1 < ocorrencias.length ? (ocorrencias[indice + 1].index || estrutura.length) : estrutura.length;
    const codigo = ocorrencias[indice][1];
    const bloco = estrutura.slice(inicio, fim);
    const professores = extrairProfessoresDoBlocoEstruturado(bloco);
    if (professores.length) resultado.set(codigo, professores);
  }

  return resultado;
}

function extrairProfessoresDoBlocoEstruturado(bloco) {
  const inicioHorario = bloco.search(/Hor[aá]rio\b/i);
  if (inicioHorario < 0) return [];

  const depoisDoHorario = bloco.slice(inicioHorario);
  const inicioVagas = depoisDoHorario.search(/Vagas\s+Inscritos\s+Pendentes\s+Matriculados/i);
  const trecho = inicioVagas >= 0 ? depoisDoHorario.slice(0, inicioVagas) : depoisDoHorario;
  const campos = trecho.split(/[\n\u241F]+/).map(normalizarTexto).filter(Boolean);
  const nomes = [];
  let aguardandoProfessor = false;

  for (let campo of campos) {
    campo = normalizarTexto(campo)
      .replace(/^Hor[aá]rio\s*/i, '')
      .replace(/^Prof\.?\(a\)\.?\s*/i, '');
    if (!campo || /^(?:Hor[aá]rio|Prof\.?\(a\)?)\.?$/i.test(campo)) continue;

    const horarios = Array.from(campo.matchAll(/\b(?:seg|ter|qua|qui|sex|s[aá]b|dom)\b\s+\d{1,2}:\d{2}\s+\d{1,2}:\d{2}(?:\s*\([^)]*\))?/gi));
    if (horarios.length) {
      const restante = normalizarTexto(campo.replace(/\b(?:seg|ter|qua|qui|sex|s[aá]b|dom)\b\s+\d{1,2}:\d{2}\s+\d{1,2}:\d{2}(?:\s*\([^)]*\))?/gi, ' '));
      if (restante) nomes.push(restante);
      aguardandoProfessor = !restante;
      continue;
    }

    if (aguardandoProfessor && !/^(?:Tipo|Observa|In[ií]cio|Fim|C(?:[oó]|�)digo\s+da\s+Turma)/i.test(campo)) {
      nomes.push(campo);
      aguardandoProfessor = false;
    }
  }

  return normalizarProfessores(nomes);
}

function extrairProfessoresDoTextoPlano(texto) {
  const inicioHorario = String(texto || '').search(/Hor[aá]rio\b/i);
  if (inicioHorario < 0) return [];

  const depoisDoHorario = String(texto).slice(inicioHorario);
  const inicioVagas = depoisDoHorario.search(/Vagas\s+Inscritos\s+Pendentes\s+Matriculados/i);
  const trecho = inicioVagas >= 0 ? depoisDoHorario.slice(0, inicioVagas) : depoisDoHorario;
  const marcador = /\b(?:seg|ter|qua|qui|sex|s[aá]b|dom)\b\s+\d{1,2}:\d{2}\s+\d{1,2}:\d{2}(?:\s*\([^)]*\))?/gi;
  const horarios = Array.from(trecho.matchAll(marcador));
  const nomes = [];

  for (let indice = 0; indice < horarios.length; indice += 1) {
    const inicio = (horarios[indice].index || 0) + horarios[indice][0].length;
    const fim = indice + 1 < horarios.length ? (horarios[indice + 1].index || trecho.length) : trecho.length;
    const candidato = normalizarTexto(trecho.slice(inicio, fim)
      .replace(/^(?:Prof\.?\(a\)\.?\s*)?/i, ''));
    if (candidato) nomes.push(candidato);
  }

  return normalizarProfessores(nomes);
}

function normalizarProfessores(nomes) {
  const vistos = new Set();
  const resultado = [];

  for (const nomeOriginal of nomes || []) {
    const nome = normalizarTexto(nomeOriginal)
      .replace(/\b(?:Hor[aá]rio|Prof\.?\(a\)?)\b/gi, '')
      .replace(/^[-–·,:;]+|[-–·,:;]+$/g, '')
      .trim();
    if (!nome || nome.length < 3 || /^(?:Vagas|Inscritos|Pendentes|Matriculados)$/i.test(nome)) continue;
    const chave = nome.toLocaleLowerCase('pt-BR');
    if (!vistos.has(chave)) {
      vistos.add(chave);
      resultado.push(nome);
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
  const regex = /\b(Obrigat(?:ória|�ria)|Optativa\s+Eletiva|Optativa\s+Livre|Alunos\s+Especiais|Extracurricular|Qualquer\s+Unidade(?:\s+da\s+USP)?)\s+(\d+)\s+(\d+)\s+(-|\d+)\s+(\d+)/gi;
  for (const encontrado of texto.matchAll(regex)) {
    const vagas = Number(encontrado[2]);
    if (!Number.isFinite(vagas) || vagas <= 0) continue;
    categorias.push({
      nome: normalizarTexto(encontrado[1]),
      vagas,
      inscritos: Number(encontrado[3]) || 0,
      pendentes: encontrado[4] === '-' ? 0 : Number(encontrado[4]) || 0,
      matriculados: Number(encontrado[5]) || 0
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
  return turmas.reduce((soma, turma) => ({
    inscritos: soma.inscritos + Number(turma.inscritos || 0),
    pendentes: soma.pendentes + Number(turma.pendentes || 0),
    matriculados: soma.matriculados + Number(turma.matriculados || 0)
  }), { inscritos: 0, pendentes: 0, matriculados: 0 });
}

function ordenarDisciplinas(disciplinas) {
  disciplinas.sort((a, b) => resumirPessoas(b).pessoas - resumirPessoas(a).pessoas || a.codigo.localeCompare(b.codigo));
}


/**
 * Histórico anual compactado.
 *
 * Cada disciplina guarda segmentos de datas consecutivas com o mesmo estado.
 * Ex.: 01–15/08 com 23 inscritos ocupa um único registro; a interface expande
 * esse intervalo em pontos diários apenas na hora de desenhar o gráfico.
 */
async function registrarSnapshotDiario(env, dados, full, agora) {
  const data = full?.data || dataBrt(agora);
  const confirmadas = full?.confirmadas || {};
  const codigos = Array.isArray(full?.codigos) && full.codigos.length
    ? full.codigos
    : Object.keys(confirmadas);

  if (!codigos.length) return;

  const historico = await lerHistorico(env);
  historico.cursos ||= {};
  historico.ultimaData = data;
  historico.atualizadoEm = agora;

  const disciplinasPorCodigo = new Map((dados.disciplinas || []).map((disciplina) => [disciplina.codigo, disciplina]));

  for (const codigo of codigos) {
    // Falha transitória não deve virar zero no gráfico. Nesse caso, o último
    // estado confirmado permanece encerrado e a interface mostra uma lacuna.
    const situacao = confirmadas[codigo];
    if (!situacao) continue;

    const disciplina = disciplinasPorCodigo.get(codigo);
    const curso = historico.cursos[codigo] ||= { nome: disciplina?.nome || codigo, segmentos: [] };
    if (disciplina?.nome) curso.nome = disciplina.nome;

    let estado;
    if (situacao === 'ofertada' && disciplina) {
      const pessoas = resumirPessoas(disciplina);
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

    inserirEstadoNoHistorico(curso.segmentos, data, estado);
  }

  limitarHistorico(historico, data);
  await salvarHistorico(env, historico);
}

function inserirEstadoNoHistorico(segmentos, data, estado) {
  const normalizados = Array.isArray(segmentos) ? segmentos : [];
  let indice = normalizados.findIndex((segmento) => segmento.inicio <= data && data <= segmento.fim);

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

function limitarHistorico(historico, dataReferencia) {
  const corte = deslocarData(dataReferencia, -(DIAS_HISTORICO - 1));
  for (const curso of Object.values(historico.cursos || {})) {
    const mantidos = [];
    for (const segmento of curso.segmentos || []) {
      if (segmento.fim < corte) continue;
      if (segmento.inicio < corte) segmento.inicio = corte;
      mantidos.push(segmento);
    }
    curso.segmentos = mantidos;
  }
}

async function responderHistorico(url, env) {
  const historico = await lerHistorico(env);
  const codigo = String(url.searchParams.get('codigo') || '').trim().toUpperCase();

  if (!codigo) {
    const catalogo = Object.entries(historico.cursos || {})
      .map(([itemCodigo, curso]) => ({ codigo: itemCodigo, nome: curso.nome || itemCodigo }))
      .sort((a, b) => a.codigo.localeCompare(b.codigo));
    return {
      catalogo,
      ultimaData: historico.ultimaData || null,
      atualizadoEm: historico.atualizadoEm || null
    };
  }

  if (!/^PNV\d{4}$/.test(codigo)) {
    return { codigo, erro: 'Código de disciplina inválido.', serie: [] };
  }

  const curso = historico.cursos?.[codigo];
  if (!curso) {
    return { codigo, nome: codigo, ultimaData: historico.ultimaData || null, serie: [] };
  }

  const diasSolicitados = limitarNumero(url.searchParams.get('dias'), 365, 30, DIAS_HISTORICO);
  const fim = historico.ultimaData || dataBrt(Date.now());
  const inicioSolicitado = deslocarData(fim, -(diasSolicitados - 1));
  const primeiraData = (curso.segmentos || []).reduce((menor, segmento) => !menor || segmento.inicio < menor ? segmento.inicio : menor, null);
  const inicio = primeiraData && primeiraData > inicioSolicitado ? primeiraData : inicioSolicitado;
  const serie = expandirHistorico(curso.segmentos || [], inicio, fim);

  return {
    codigo,
    nome: curso.nome || codigo,
    inicio,
    fim,
    primeiraData,
    ultimaData: historico.ultimaData || null,
    serie
  };
}

function expandirHistorico(segmentos, inicio, fim) {
  const serie = [];
  for (let data = inicio; data <= fim; data = diaSeguinte(data)) {
    const segmento = segmentos.find((item) => item.inicio <= data && data <= item.fim);
    if (!segmento) {
      serie.push({ data, ofertada: null, inscritos: null, pendentes: null, matriculados: null, pessoas: null });
      continue;
    }
    const inscritos = Number(segmento.inscritos || 0);
    const pendentes = Number(segmento.pendentes || 0);
    const matriculados = Number(segmento.matriculados || 0);
    serie.push({
      data,
      ofertada: Boolean(segmento.ofertada),
      inscritos,
      pendentes,
      matriculados,
      pessoas: inscritos + pendentes + matriculados
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

function montarResposta(dados, estado) {
  const disciplinas = [...(dados.disciplinas || [])];
  ordenarDisciplinas(disciplinas);
  const agora = Date.now();
  return {
    disciplinas,
    meta: {
      geradoEm: agora,
      ultimaAtualizacao: dados.ultimaAtualizacao || null,
      ultimaAtualizacaoCurta: dados.ultimaAtualizacaoCurta || null,
      ultimaConsultaCompleta: dados.ultimaConsultaCompleta || null,
      ultimaListaPNV: dados.ultimaListaPNV || null,
      ultimoErro: dados.ultimoErro || null,
      proximaAtualizacaoCurta: proximoMultiploDeCincoMinutos(agora),
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
  return (await lerJson(env, KEY_DADOS)) || { disciplinas: [], ultimaAtualizacao: null, ultimoErro: null };
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
