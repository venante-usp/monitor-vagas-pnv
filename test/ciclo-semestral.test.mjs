/**
 * Teste do ciclo semestral automático (sem rede e sem Cloudflare).
 * Simula o KV e o Júpiter e percorre: migração dos dados antigos →
 * "Não existe oferecimento" (congelamento) → abertura do próximo semestre →
 * arquivamento automático. Uso: npm test
 */
import assert from 'node:assert/strict';

const WORKER = new URL('../src/worker.js', import.meta.url).href;
const realSetTimeout = globalThis.setTimeout;
// Pausas entre consultas viram 0 ms; o timeout de 25 s continua real.
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 25000 ? ms : 0, ...a);
let fakeNow = Date.parse('2026-11-12T15:00:00Z');
const RealDate = Date;
Date.now = () => fakeNow;

const codigos = ['PNV3100', 'PNV3212', 'PNV3321', 'PNV3412'];
const lista = `<html><body>${'<!-- -->'.repeat(20)}<table><tr><th>Sigla</th><th>Nome</th><th>Ativação</th><th>Desativação</th></tr>${codigos.map((c) => `<tr><td>${c}</td><td>Disciplina ${c}</td><td>01/01/2025</td><td></td></tr>`).join('')}</table></body></html>`;
// Mensagem real do Júpiter, com o "ã" corrompido como ele devolve.
const naoExiste = (c) => `<html><body>${'<!-- -->'.repeat(20)}<div>Mensagem - 12/11/2026 09:50:34</div><div>N?o existe oferecimento para a sigla ${c}</div><a>&lt;&lt; voltar</a></body></html>`;

function paginaTurma(codigo, turmas) {
  const blocos = turmas.map((t) => `
<table><tr><td>Código da Turma:</td><td>${t.codigo}</td></tr>
<tr><td>Início:</td><td>${t.inicio}</td></tr>
<tr><td>Fim:</td><td>${t.fim}</td></tr>
<tr><td>Tipo da Turma:</td><td>Teórica</td></tr>
<tr><td>Observações:</td><td></td></tr></table>
<table><tr><td>Horário</td><td></td><td>Prof(a).</td></tr>
<tr><td>seg</td><td>07:30</td><td>09:10</td><td><a href="#">Fulano de Tal Silva</a></td></tr></table>
<table><tr><td></td><td>Vagas</td><td>Inscritos</td><td>Pendentes</td><td>Matriculados</td></tr>
<tr><td>Obrigatória</td><td>60</td><td>40</td><td>0</td><td>30</td></tr>
<tr><td></td><td>Escola Politécnica - Habilitação em Engenharia Naval</td><td>50</td><td>35</td><td>0</td><td>25</td></tr>
<tr><td></td><td>Escola Politécnica - Engenharia Mecânica</td><td>10</td><td>5</td><td>0</td><td>5</td></tr>
<tr><td>Optativa Livre</td><td>5</td><td>2</td><td>0</td><td>1</td></tr>
<tr><td></td><td>Qualquer Unidade da USP</td><td>5</td><td>2</td><td>0</td><td>1</td></tr></table>`).join('');
  return `<html><body>${'x'.repeat(200)}<div>Disciplina: ${codigo} - Introdução ao Projeto de Engenharia</div>
<div>Clique para consultar os requisitos</div><div>Lista de Turmas oferecidas</div>${blocos}</body></html>`;
}

let ofertas = {}; // codigo -> turmas
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('jupDisciplinaLista')) return new Response(lista, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (u.includes('obterTurma')) {
    const c = new URL(u).searchParams.get('sgldis');
    if (ofertas[c]) return new Response(paginaTurma(c, ofertas[c]), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response(naoExiste(c), { headers: { 'content-type': 'text/html' } });
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

// Dados legados (antes do ciclo semestral): turmas de 2026/2 sem datas.
kv.set('monitor:latest', JSON.stringify({
  disciplinas: [
    { codigo: 'PNV3100', nome: 'PNV3100 - Intro', atualizadaEm: Date.parse('2026-11-01T12:00:00Z'), turmas: [{ codigo: '2026201', categoria: 'Obrigatória', total: 60, inscritos: 50, pendentes: 0, matriculados: 45, horario: 'seg 07:30 09:10' }] },
    { codigo: 'PNV3212', nome: 'PNV3212 - X', atualizadaEm: Date.parse('2026-11-01T12:00:00Z'), turmas: [{ codigo: 'ABC', categoria: 'Obrigatória', total: 40, inscritos: 10, pendentes: 0, matriculados: 5, horario: 'ter 07:30 09:10' }] }
  ],
  desativadas: [], ultimaAtualizacao: Date.parse('2026-11-01T12:00:00Z')
}));
kv.set('monitor:state', JSON.stringify({ full: { data: '2026-11-11', emAndamento: false, codigos: [] }, cursorCurto: 0 }));

const worker = (await import(WORKER)).default;
const ctx = { waitUntil: (p) => pending.push(p) };
let pending = [];
async function tick(iso) {
  fakeNow = RealDate.parse(iso);
  pending = [];
  await worker.scheduled({ scheduledTime: fakeNow }, env, ctx);
  await Promise.all(pending);
}
async function api(q = '') {
  const r = await worker.fetch(new Request(`https://x/api/monitor${q}`), env, ctx);
  return r.json();
}

// 1) Leitura logo após o deploy: migração em memória
let d = await api();

assert.equal(d.semestrePadrao, '2026-2');
assert.deepEqual(d.disciplinas.map((x) => x.codigo).sort(), ['PNV3100', 'PNV3212']);
assert.ok(d.semestres.some((s) => s.id === '2027-1' && s.situacao === 'aguardando'));

// 2) Scan diário de 12/11: Júpiter diz "não existe oferecimento" para tudo
await tick('2026-11-12T03:00:00Z');
for (let i = 0; i < 30; i++) await tick(`2026-11-12T${String(4 + Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}:00Z`);
const estado = JSON.parse(kv.get("monitor:state"));

assert.equal(estado.full.emAndamento, false);
assert.equal(estado.full.semOferta, codigos.length);
d = await api();

assert.equal(d.semestre.situacao, 'congelado');
assert.equal(d.disciplinas.length, 2);
assert.equal(d.meta.atualizacaoCurtaModo, 'procurando_novas_turmas');

// 3) 05/12: Júpiter publica turmas de 2027/1 para PNV3100; atualização curta acha
ofertas.PNV3100 = [{ codigo: '2027101', inicio: '22/02/2027', fim: '03/07/2027' }];
for (let i = 0; i < 30; i++) await tick(`2026-12-05T1${Math.floor(i / 12)}:${String((i % 12) * 5).padStart(2, '0')}:00Z`);
d = await api();

assert.equal(d.semestrePadrao, '2027-1');
assert.equal(d.disciplinas[0].turmas[0].inicio, '2027-02-22');
assert.equal(d.disciplinas[0].turmas[0].semestre, '2027-1');
// Vagas reservadas por curso, abaixo de cada tipo de vaga.
const obrigatoria = d.disciplinas[0].turmas.find((t) => /^Obrigat/.test(t.categoria));
assert.deepEqual(obrigatoria.cursos.map((c) => [c.nome, c.vagas, c.matriculados]), [
  ['Escola Politécnica - Habilitação em Engenharia Naval', 50, 25],
  ['Escola Politécnica - Engenharia Mecânica', 10, 5]
]);
const livre = d.disciplinas[0].turmas.find((t) => t.categoria === 'Optativa Livre');
assert.deepEqual(livre.cursos.map((c) => c.nome), ['Qualquer Unidade da USP']);
// Os totais por tipo de vaga não mudam com a leitura dos cursos.
assert.equal(obrigatoria.total, 60);
assert.equal(obrigatoria.matriculados, 30);

let d2 = await api('?semestre=2026-2');

assert.equal(d2.disciplinas.length, 2);

// 4) 20/01/2027: 2026/2 passou do fim + carência -> arquivado no scan diário
for (let i = 0; i < 20; i++) await tick(`2027-01-20T0${4 + Math.floor(i / 12)}:${String((i % 12) * 5).padStart(2, '0')}:00Z`);
d = await api();

assert.deepEqual(d.arquivo.map((a) => a.id), ['2026-2']);
assert.ok(!d.semestres.some((s) => s.id === '2026-2'));
assert.ok(kv.has('monitor:semestre:arquivo:v1:2026-2'));
d2 = await api('?semestre=2026-2');

assert.equal(d2.semestre.arquivado, true);
assert.equal(d2.disciplinas.length, 2);

// 5) Turmas de 2027/1 somem do Júpiter no meio do semestre -> congela, não apaga
delete ofertas.PNV3100;
for (let i = 0; i < 30; i++) await tick(`2027-05-10T1${Math.floor(i / 12)}:${String((i % 12) * 5).padStart(2, '0')}:00Z`);
d = await api();

assert.equal(d.semestre.id, '2027-1');
assert.equal(d.semestre.situacao, 'congelado');

// 6) Próximo: 2027-2 aparece como placeholder perto do fim (03/07 - 75d = 19/04)
assert.ok(d.semestres.some((s) => s.id === '2027-2' && s.situacao === 'aguardando'));
// 7) Arquivamento de 2027-1 em 18/07 (fim 03/07 + 14)
for (let i = 0; i < 20; i++) await tick(`2027-07-18T0${4 + Math.floor(i / 12)}:${String((i % 12) * 5).padStart(2, '0')}:00Z`);
d = await api();

assert.deepEqual(d.arquivo.map((a) => a.id), ['2027-1', '2026-2']); assert.deepEqual(d.semestres.map((s) => s.id), ['2027-2']); assert.equal(d.semestrePadrao, '2027-2');

// histórico continua ok
const h = await (await worker.fetch(new Request('https://x/api/historico?codigo=PNV3100&dias=todo'), env, ctx)).json();
assert.ok(h.serie.some((p) => p.ofertada === true));
console.log('ok - ciclo semestral: migração, congelamento, novo semestre e arquivamento');
