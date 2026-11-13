/**
 * Teste da leitura das páginas de turma do Júpiter (sem rede e sem Cloudflare).
 *
 * A página simulada segue a estrutura real descrita por outros leitores do
 * Júpiter (ex.: MatrUSP): uma tabela por bloco — dados da turma, horário
 * (dia | início | fim | professor), "Atividades Didáticas" e vagas, com as
 * linhas de curso abaixo de cada tipo de vaga começando por uma célula vazia.
 *
 * Também confere a correção, na leitura, de dados já gravados com os erros
 * antigos: rótulos como "Atividades Didáticas" na lista de professores,
 * "(R)" no horário, "Qualquer Unidade da USP" contada como tipo de vaga e
 * inscritos subtraídos mais de uma vez. Uso: npm test
 */
import assert from 'node:assert/strict';

const WORKER = new URL('../src/worker.js', import.meta.url).href;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 25000 ? ms : 0, ...a);
const RealDate = Date;
let fakeNow = RealDate.parse('2026-11-13T15:00:00Z');
Date.now = () => fakeNow;

const lista = `<html><body>${'<!-- -->'.repeat(20)}<table><tr><th>Sigla</th><th>Nome</th><th>Ativação</th><th>Desativação</th></tr>
<tr><td>PNV3412</td><td>Sistemas Oceânicos</td><td>01/01/2025</td><td></td></tr>
<tr><td>PNV3100</td><td>Introdução ao Projeto de Engenharia</td><td>01/01/2025</td><td></td></tr></table></body></html>`;
const naoExiste = (c) => `<html><body>${'<!-- -->'.repeat(20)}<div>N?o existe oferecimento para a sigla ${c}</div></body></html>`;

// Página no formato real: (R) antes do professor responsável, linha extra de
// professor, encontro sem dia (continua no mesmo dia), tabela de atividades
// didáticas e linhas de curso com a primeira célula vazia.
const paginaPNV3412 = `<html><body>${'<!-- -->'.repeat(20)}
<table><tr><td>Disciplina: PNV3412 - Sistemas Oceânicos</td></tr><tr><td>Lista de Turmas oferecidas</td></tr></table>
<table>
  <tr><td><b>Código da Turma:</b></td><td>2027150</td></tr>
  <tr><td><b>Início:</b></td><td>22/02/2027</td></tr>
  <tr><td><b>Fim:</b></td><td>03/07/2027</td></tr>
  <tr><td><b>Tipo da Turma:</b></td><td>Teórica</td></tr>
  <tr><td><b>Observações:</b></td><td>&nbsp;</td></tr>
</table>
<table>
  <tr><td><b>Horário</b></td><td></td><td></td><td><b>Prof(a).</b></td></tr>
  <tr><td>seg</td><td>08:20</td><td>10:10</td><td>(R) Marcos Mendes de Oliveira Pinto</td></tr>
  <tr><td></td><td></td><td></td><td>Ana Paula de Souza Lima</td></tr>
  <tr><td>qua</td><td>10:00</td><td>11:40</td><td>(R) Marcos Mendes de Oliveira Pinto</td></tr>
  <tr><td></td><td>14:00</td><td>15:40</td><td>Ana Paula de Souza Lima</td></tr>
</table>
<table>
  <tr><td colspan="3"><b>Atividades Didáticas</b></td></tr>
  <tr><td><b>Prof(a).</b></td><td><b>Tipo de Atividade</b></td><td><b>Carga horária (total)</b></td></tr>
  <tr><td>Paula Birocchi</td><td>Atividades de extensão</td><td>30</td></tr>
</table>
<table>
  <tr><td></td><td>Vagas</td><td>Inscritos</td><td>Pendentes</td><td>Matriculados</td></tr>
  <tr><td>Obrigatória</td><td>47</td><td>52</td><td>0</td><td>40</td></tr>
  <tr><td></td><td>Escola Politécnica - Habilitação em Engenharia Naval</td><td>47</td><td>52</td><td>0</td><td>40</td></tr>
  <tr><td>Optativa Livre</td><td>5</td><td>3</td><td>1</td><td>1</td></tr>
  <tr><td></td><td>Qualquer Unidade da USP</td><td>5</td><td>3</td><td>1</td><td>1</td></tr>
</table>
</body></html>`;

const paginas = { PNV3412: null, PNV3100: null };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('jupDisciplinaLista')) return new Response(lista, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (u.includes('obterTurma')) {
    const c = new URL(u).searchParams.get('sgldis');
    return new Response(paginas[c] || naoExiste(c), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return new Response('nope', { status: 404 });
};

const kv = new Map();
const env = {
  PNV_MONITOR: {
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); }
  },
  ASSETS: { fetch: async () => new Response('asset') }
};

// Dados gravados pela versão anterior, como apareceram no site em 2026/2.
const atualizadaEm = RealDate.parse('2026-11-01T12:00:00Z');
kv.set('monitor:latest', JSON.stringify({
  disciplinas: [
    {
      codigo: 'PNV3412', nome: 'PNV3412 - Sistemas Oceânicos', atualizadaEm,
      turmas: [
        {
          codigo: '2026250', categoria: 'Obrigatória', total: 47, inscritos: 0, pendentes: 0, matriculados: 47,
          horario: 'seg 08:20 10:10 (R)', dia: 'seg',
          professores: ['Marcos Mendes de Oliveira Pinto', 'Atividades Didáticas', 'Tipo de Atividade', 'Carga horária (total)', 'Paula Birocchi', 'Atividades de extensão']
        },
        { codigo: '2026250', categoria: 'Optativa Livre', total: 5, inscritos: 2, pendentes: 1, matriculados: 1, horario: 'seg 08:20 10:10 (R)', professores: ['Marcos Mendes de Oliveira Pinto'] },
        { codigo: '2026250', categoria: 'Qualquer Unidade da USP', total: 5, inscritos: 2, pendentes: 1, matriculados: 1, horario: 'seg 08:20 10:10 (R)', professores: ['Marcos Mendes de Oliveira Pinto'] }
      ]
    },
    {
      codigo: 'PNV3100', nome: 'PNV3100 - Introdução ao Projeto de Engenharia', atualizadaEm,
      // "inscritos" já gravado como "aguardando" (bruto - pendentes - matriculados).
      turmas: [{ codigo: '2026201', categoria: 'Obrigatória', total: 60, inscritos: 10, pendentes: 0, matriculados: 45, horario: 'ter 07:30 09:10', professores: ['Fulano de Tal', 'Fabiana da Hora Santos', "Luiza d'Ávila Prado", 'Pedro Domingo Ruiz'] }]
    }
  ],
  desativadas: [],
  ultimaAtualizacao: atualizadaEm
}));
kv.set('monitor:state', JSON.stringify({ full: { data: '2026-11-13', emAndamento: false, codigos: ['PNV3412', 'PNV3100'] }, cursorCurto: 0 }));

// Histórico: segmento de agosto gravado com inscritos brutos (antes de
// 20/09/2026) e de outubro já gravado como "aguardando".
kv.set('monitor:history:index:v2', JSON.stringify({
  versao: 2, migracaoLegadoConcluida: true, ultimaData: '2026-10-31', atualizadoEm: atualizadaEm, bytesEstimados: 0,
  cursos: { PNV3100: { nome: 'PNV3100', meses: ['2026-08', '2026-10'] } },
  meses: { '2026-08': { bytes: 1 }, '2026-10': { bytes: 1 } }
}));
kv.set('monitor:history:month:v2:2026-08', JSON.stringify({ versao: 2, mes: '2026-08', cursos: { PNV3100: { nome: 'PNV3100', segmentos: [{ inicio: '2026-08-10', fim: '2026-08-31', ofertada: true, inscritos: 50, pendentes: 0, matriculados: 40 }] } } }));
kv.set('monitor:history:month:v2:2026-10', JSON.stringify({ versao: 2, mes: '2026-10', cursos: { PNV3100: { nome: 'PNV3100', segmentos: [{ inicio: '2026-10-01', fim: '2026-10-31', ofertada: true, inscritos: 5, pendentes: 0, matriculados: 40 }] } } }));

const worker = (await import(WORKER)).default;
let pendentes = [];
const ctx = { waitUntil: (p) => pendentes.push(p) };
async function api(caminho) {
  const r = await worker.fetch(new Request(`https://x${caminho}`), env, ctx);
  return r.json();
}
async function tick(iso) {
  fakeNow = RealDate.parse(iso);
  pendentes = [];
  await worker.scheduled({ scheduledTime: fakeNow }, env, ctx);
  await Promise.all(pendentes);
}
const turmasDe = (d, codigo) => d.disciplinas.find((x) => x.codigo === codigo).turmas;

// ---------------------------------------------------------------------------
// 1) Dados antigos são corrigidos na leitura, sem esperar nova consulta.
let d = await api('/api/monitor?semestre=2026-2');
let t3412 = turmasDe(d, 'PNV3412');
assert.deepEqual(t3412.map((t) => t.categoria), ['Obrigatória', 'Optativa Livre'], '"Qualquer Unidade da USP" é linha de curso, não tipo de vaga');
assert.deepEqual(t3412[0].professores, ['Marcos Mendes de Oliveira Pinto', 'Paula Birocchi']);
assert.equal(t3412[0].horario, 'seg 08:20 10:10');
assert.deepEqual(t3412[1].cursos.map((c) => c.nome), ['Qualquer Unidade da USP']);
assert.equal(t3412[1].inscritos, 2, 'inscritos já gravados como "aguardando" não são subtraídos de novo');
assert.equal(t3412[1].ocupadas, 4);
assert.equal(t3412[1].disponiveis, 1);
const t3100 = turmasDe(d, 'PNV3100')[0];
assert.equal(t3100.inscritos, 10);
assert.equal(t3100.ocupadas, 55);
assert.equal(t3100.disponiveis, 5);
assert.equal(t3412[1].inscritosTotal, 4, 'total do Júpiter reconstruído: 2 + 1 + 1');
assert.equal(t3412[1].cursos[0].inscritosTotal, 4);
assert.equal(t3100.inscritosTotal, 55);
// Sobrenomes que também são palavras comuns ("da Hora", "Domingo") e a
// partícula "d'" em minúscula continuam sendo nomes de docentes.
assert.deepEqual(t3100.professores, ['Fulano de Tal', 'Fabiana da Hora Santos', "Luiza d'Ávila Prado", 'Pedro Domingo Ruiz']);

// ---------------------------------------------------------------------------
// 2) Página nova do Júpiter (formato real) é lida corretamente.
paginas.PNV3412 = paginaPNV3412;
for (let i = 0; i < 6; i++) await tick(`2026-12-01T03:${String(i * 5).padStart(2, '0')}:00Z`);
d = await api('/api/monitor?semestre=2027-1');
t3412 = turmasDe(d, 'PNV3412');
assert.deepEqual(t3412.map((t) => t.categoria), ['Obrigatória', 'Optativa Livre']);
const obrig = t3412[0];
const livre = t3412[1];
assert.deepEqual(obrig.professores, ['Marcos Mendes de Oliveira Pinto', 'Ana Paula de Souza Lima', 'Paula Birocchi']);
assert.equal(obrig.horario, 'seg 08:20 10:10 qua 10:00 11:40 qua 14:00 15:40', 'todos os encontros, sem o marcador (R)');
assert.equal(obrig.inicio, '2027-02-22');
assert.equal(obrig.total, 47);
assert.equal(obrig.inscritos, 12, 'aguardando = 52 inscritos - 0 pendentes - 40 matriculados');
assert.equal(obrig.ocupadas, 52);
assert.equal(obrig.disponiveis, 0);
assert.equal(livre.inscritos, 1);
assert.equal(livre.ocupadas, 3);
assert.equal(livre.disponiveis, 2);
assert.deepEqual(obrig.cursos.map((c) => [c.nome, c.vagas]), [['Escola Politécnica - Habilitação em Engenharia Naval', 47]]);
assert.deepEqual(livre.cursos.map((c) => c.nome), ['Qualquer Unidade da USP']);
assert.equal(obrig.inscritosTotal, 52);
assert.equal(livre.inscritosTotal, 3);
assert.equal(obrig.cursos[0].inscritosTotal, 52);

// ---------------------------------------------------------------------------
// 3) Histórico: só segmentos anteriores a 20/09/2026 tinham inscritos brutos.
const h = await api('/api/historico?codigo=PNV3100&dias=todo');
const dia = (data) => h.serie.find((p) => p.data === data);
assert.equal(dia('2026-08-15').inscritos, 10);
assert.equal(dia('2026-08-15').pessoas, 50);
assert.equal(dia('2026-10-15').inscritos, 5);
assert.equal(dia('2026-10-15').pessoas, 45);
const h3412 = await api('/api/historico?codigo=PNV3412&dias=todo');
const ultimo = h3412.serie.filter((p) => p.ofertada).at(-1);
assert.equal(ultimo.pessoas, 55, 'snapshot diário: 52 (obrigatória) + 3 (optativa livre), sem contar "Qualquer Unidade" de novo');

console.log('ok - leitura do Júpiter: professores, horários, vagas por curso e contagem de inscritos');
