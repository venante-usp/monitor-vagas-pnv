/**
 * Releitura completa depois de uma correção na leitura (sem rede e sem
 * Cloudflare).
 *
 * Os dados gravados pela leitura antiga (sem os cursos de cada tipo de vaga)
 * precisam ser relidos logo após o deploy, mesmo que a varredura completa do
 * dia já tenha terminado e mesmo sem a chamada pós-deploy do build. Uso: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WORKER = new URL('../src/worker.js', import.meta.url).href;
const FIXTURES = new URL('./fixtures/jupiter/', import.meta.url);
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 25000 ? ms : 0, ...a);
const RealDate = Date;
let fakeNow = RealDate.parse('2026-11-27T16:10:00Z');
Date.now = () => fakeNow;

const siglas = ['PNV1100', 'PNV1314', 'PNV1404'];
const lista = `<html><body>${'<!-- -->'.repeat(20)}<table><tr><th>Sigla</th><th>Nome</th><th>Ativação</th><th>Desativação</th></tr>${siglas.map((c) => `<tr><td>${c}</td><td>Disciplina ${c}</td><td>01/01/2025</td><td></td></tr>`).join('')}</table></body></html>`;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
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

// Como está o KV hoje: varredura de 27/11 concluída pela leitura antiga, com a
// PNV1404 gravada sem cursos e com "Qualquer Unidade da USP" como tipo de vaga.
const gravadaEm = RealDate.parse('2026-11-27T04:00:00Z');
const turmaAntiga = { codigo: '2027150', grupoTurma: '2027150', tipoTurma: 'Teórica', turmaTeoricaVinculada: null, inicio: '2027-03-01', fim: '2027-07-07', semestre: '2027-1', horario: 'ter 14:00 18:00', professores: ['Paula Birocchi', 'Pedro Cardozo de Mello'], dia: 'ter', cursos: [], ocupadas: 0, inscritos: 0, inscritosTotal: 0, pendentes: 0, matriculados: 0 };
const disciplinaAntiga = {
  codigo: 'PNV1404', nome: 'PNV1404 - Monitoramento Oceânico', atualizadaEm: gravadaEm,
  turmas: [
    { ...turmaAntiga, categoria: 'Optativa Livre', total: 25, disponiveis: 25 },
    { ...turmaAntiga, categoria: 'Qualquer Unidade da USP', total: 10, disponiveis: 10 }
  ]
};
kv.set('monitor:latest', JSON.stringify({
  disciplinas: [disciplinaAntiga],
  semestres: { '2027-1': { id: '2027-1', criadoEm: gravadaEm, atualizadoEm: gravadaEm, disciplinas: { PNV1404: { ...disciplinaAntiga, noJupiter: true, vistaNoJupiterEm: gravadaEm, retiradaDoJupiterEm: null } } } },
  arquivo: [], desativadas: [], ultimaAtualizacao: gravadaEm
}));
kv.set('monitor:state', JSON.stringify({
  full: { data: '2026-11-27', emAndamento: false, total: 3, concluidas: 3, comTurmas: 1, semOferta: 2, falhas: 0, fila: [], codigos: siglas, confirmadas: {}, iniciadoEm: RealDate.parse('2026-11-27T03:00:00Z'), concluidoEm: gravadaEm },
  cursorCurto: 0
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
async function api(caminho) {
  const r = await worker.fetch(new Request(`https://x${caminho}`), env, ctx);
  return r.json();
}

// Primeiro ciclo depois do deploy: recomeça a varredura completa hoje mesmo.
await tick('2026-11-27T16:10:00Z');
let d = await api('/api/monitor?semestre=2027-1');
assert.equal(d.meta.fullScan.iniciadoEm, RealDate.parse('2026-11-27T16:10:00Z'), 'a correção dispara uma nova varredura completa');
await tick('2026-11-27T16:15:00Z');
d = await api('/api/monitor?semestre=2027-1');
assert.equal(d.meta.fullScan.emAndamento, false);
assert.equal(d.meta.fullScan.concluidas, 3);
const t1404 = d.disciplinas.find((x) => x.codigo === 'PNV1404').turmas;
assert.deepEqual(t1404.map((v) => v.categoria), ['Optativa Livre', 'Alunos Especiais', 'Extracurricular']);
assert.deepEqual(t1404[0].cursos.map((c) => c.nome), ['EP - para toda a Unidade', 'Qualquer Unidade da USP']);

// Terminada a releitura, os ciclos seguintes voltam às atualizações curtas.
await tick('2026-11-27T16:20:00Z');
await tick('2026-11-27T16:25:00Z');
d = await api('/api/monitor');
assert.equal(d.meta.fullScan.iniciadoEm, RealDate.parse('2026-11-27T16:10:00Z'), 'a releitura não recomeça a cada ciclo');
assert.equal(d.meta.ultimaAtualizacaoCurta, RealDate.parse('2026-11-27T16:25:00Z'));

console.log('ok - correção na leitura: releitura completa no ciclo seguinte ao deploy, uma única vez');
