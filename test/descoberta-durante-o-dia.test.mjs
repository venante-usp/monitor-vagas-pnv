/**
 * Turmas cadastradas no Júpiter durante o dia (sem rede e sem Cloudflare).
 *
 * Na época de cadastro, a coordenação publica as disciplinas aos poucos. A
 * varredura completa só acontece à meia-noite; depois dela, a atualização
 * curta revisitava apenas as disciplinas já ofertadas, e quem fosse publicada
 * de manhã só aparecia no site no dia seguinte. Aqui a meia-noite encontra só
 * a PNV1100; às 9h o Júpiter publica PNV1314 e PNV1404. Uso: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WORKER = new URL('../src/worker.js', import.meta.url).href;
const FIXTURES = new URL('./fixtures/jupiter/', import.meta.url);
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 25000 ? ms : 0, ...a);
const RealDate = Date;
let fakeNow = RealDate.parse('2026-11-27T03:00:00Z');
Date.now = () => fakeNow;

// Lista oficial: as três disciplinas reais e outras nove ainda sem oferta.
const siglas = ['PNV1100', 'PNV1120', 'PNV1221', 'PNV1222', 'PNV1314', 'PNV1321', 'PNV1322', 'PNV1323', 'PNV1324', 'PNV1404', 'PNV1560', 'PNV2411'];
const lista = `<html><body>${'<!-- -->'.repeat(20)}<table><tr><th>Sigla</th><th>Nome</th><th>Ativação</th><th>Desativação</th></tr>${siglas.map((c) => `<tr><td>${c}</td><td>Disciplina ${c}</td><td>01/01/2025</td><td></td></tr>`).join('')}</table></body></html>`;
const naoExiste = (c) => `<html><body>${'<!-- -->'.repeat(20)}<div>Mensagem - 27/11/2026 09:50:34</div><div>N?o existe oferecimento para a sigla ${c}</div><a>&lt;&lt; voltar</a></body></html>`;

let publicadas = new Set(['PNV1100']);
let consultas = []; // siglas pedidas ao Júpiter no ciclo atual
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith('/jupDisciplinaLista')) return new Response(lista, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (u.pathname.endsWith('/obterTurma')) {
    const sigla = u.searchParams.get('sgldis');
    consultas.push(sigla);
    if (publicadas.has(sigla)) {
      return new Response(fs.readFileSync(new URL(`${sigla}.html`, FIXTURES)), { headers: { 'content-type': 'text/html;charset=ISO-8859-1' } });
    }
    return new Response(naoExiste(sigla), { headers: { 'content-type': 'text/html;charset=ISO-8859-1' } });
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

const worker = (await import(WORKER)).default;
let pendentes = [];
const ctx = { waitUntil: (p) => pendentes.push(p) };
async function tick(ms) {
  fakeNow = ms;
  pendentes = [];
  consultas = [];
  await worker.scheduled({ scheduledTime: fakeNow }, env, ctx);
  await Promise.all(pendentes);
  return consultas;
}
async function api(caminho) {
  const r = await worker.fetch(new Request(`https://x${caminho}`), env, ctx);
  return r.json();
}
const CINCO_MIN = 5 * 60 * 1000;

// Meia-noite de Brasília: a varredura completa termina com só a PNV1100.
let instante = RealDate.parse('2026-11-27T03:00:00Z');
for (let i = 0; i < 6; i++, instante += CINCO_MIN) await tick(instante);
let d = await api('/api/monitor');
assert.equal(d.meta.fullScan.emAndamento, false, 'a varredura da meia-noite terminou');
assert.deepEqual(d.disciplinas.map((x) => x.codigo), ['PNV1100']);

// 9h: o Júpiter passa a mostrar PNV1314 e PNV1404. Três horas de ciclos curtos.
publicadas = new Set(['PNV1100', 'PNV1314', 'PNV1404']);
const pedidas = [];
for (instante = RealDate.parse('2026-11-27T12:00:00Z'); instante < RealDate.parse('2026-11-27T15:00:00Z'); instante += CINCO_MIN) {
  pedidas.push(await tick(instante));
}

d = await api('/api/monitor?semestre=2027-1');
assert.deepEqual(d.disciplinas.map((x) => x.codigo).sort(), ['PNV1100', 'PNV1314', 'PNV1404'], 'publicadas de manhã aparecem sem esperar a meia-noite');
assert.deepEqual(d.disciplinas.find((x) => x.codigo === 'PNV1404').turmas[0].cursos.map((c) => c.nome), ['EP - para toda a Unidade', 'Qualquer Unidade da USP']);

// Ritmo gentil com o Júpiter: no máximo 5 consultas por ciclo de 5 minutos.
assert.ok(pedidas.every((lote) => lote.length <= 5), `consultas por ciclo: ${pedidas.map((l) => l.length).join(',')}`);
// A disciplina já ofertada continua sendo atualizada pelo menos a cada 30 minutos.
for (let i = 0; i + 6 <= pedidas.length; i++) {
  assert.ok(pedidas.slice(i, i + 6).some((lote) => lote.includes('PNV1100')), `PNV1100 ficou 30 min sem atualização a partir do ciclo ${i}`);
}

console.log('ok - turmas publicadas durante o dia aparecem pela atualização curta');
