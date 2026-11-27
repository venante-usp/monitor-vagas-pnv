/**
 * A releitura completa consulta só a lista oficial PNV e as páginas de turma
 * (sem rede e sem Cloudflare). A leitura da grade curricular do Júpiter servia
 * apenas ao painel de docentes do DOCX da aba Grade horária, que saiu do site.
 * Uso: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WORKER = new URL('../src/worker.js', import.meta.url).href;
const FIXTURES = new URL('./fixtures/jupiter/', import.meta.url);
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 25000 ? ms : 0, ...a);
const RealDate = Date;
let fakeNow = RealDate.parse('2026-11-28T03:00:00Z');
Date.now = () => fakeNow;

const siglas = ['PNV1100', 'PNV1314', 'PNV1404'];
const lista = `<html><body>${'<!-- -->'.repeat(20)}<table><tr><th>Sigla</th><th>Nome</th><th>Ativação</th><th>Desativação</th></tr>${siglas.map((c) => `<tr><td>${c}</td><td>Disciplina ${c}</td><td>01/01/2025</td><td></td></tr>`).join('')}</table></body></html>`;
const paginasConsultadas = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  paginasConsultadas.push(u.pathname.split('/').pop());
  if (u.pathname.endsWith('/jupDisciplinaLista')) return new Response(lista, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (u.pathname.endsWith('/obterTurma')) {
    return new Response(fs.readFileSync(new URL(`${u.searchParams.get('sgldis')}.html`, FIXTURES)), { headers: { 'content-type': 'text/html;charset=ISO-8859-1' } });
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

// Como está o KV hoje: com o campo da classificação curricular, que nunca
// encontrou a grade de Engenharia Naval nas listas de cursos.
kv.set('monitor:latest', JSON.stringify({
  disciplinas: [], semestres: {}, arquivo: [], desativadas: [], ultimaAtualizacao: null,
  curriculo: { versao: 2, atualizadoEm: null, porCodigo: {}, pendentes: siglas, fontes: [], ultimoErro: 'habilitação atual: A lista não trouxe links de grade para Engenharia Naval.' }
}));

const worker = (await import(WORKER)).default;
let pendentes = [];
const ctx = { waitUntil: (p) => pendentes.push(p) };
async function tick(iso) {
  fakeNow = RealDate.parse(iso);
  pendentes = [];
  await worker.scheduled({ scheduledTime: fakeNow }, env, ctx);
  await Promise.all(pendentes);
}

// Meia-noite em Brasília: começa a releitura completa das 3 siglas.
await tick('2026-11-28T03:00:00Z');
await tick('2026-11-28T03:05:00Z');
assert.deepEqual([...new Set(paginasConsultadas)].sort(), ['jupDisciplinaLista', 'obterTurma'], 'só a lista oficial e as páginas de turma');

const resposta = await worker.fetch(new Request('https://x/api/monitor'), env, ctx);
const dados = await resposta.json();
assert.equal(dados.meta.fullScan.emAndamento, false);
assert.equal(dados.meta.fullScan.comTurmas, 3);
assert.ok(!('curriculo' in dados), 'a API não entrega mais a classificação curricular');
assert.ok(!('curriculo' in JSON.parse(kv.get('monitor:latest'))), 'o campo antigo sai do KV na gravação seguinte');

console.log('ok - releitura completa sem consultar a grade curricular do Júpiter');
