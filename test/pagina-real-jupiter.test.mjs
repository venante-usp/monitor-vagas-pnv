/**
 * Leitura de páginas REAIS do Júpiter (sem rede e sem Cloudflare).
 *
 * As fixtures em test/fixtures/jupiter/ são as páginas obterTurma baixadas do
 * Júpiter em 27/11/2026, com os bytes intactos (ISO-8859-1, com as quebras de
 * linha do código-fonte entre as células). As páginas simuladas dos outros
 * testes têm cada linha da tabela numa linha só e por isso não pegavam o
 * defeito: a leitura dos cursos ("reservadas para") nunca funcionou no site.
 *
 * Valores esperados conferidos à mão nas páginas. Uso: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const WORKER = new URL('../src/worker.js', import.meta.url).href;
const FIXTURES = new URL('./fixtures/jupiter/', import.meta.url);
const realSetTimeout = globalThis.setTimeout;
// Pausas entre consultas viram 0 ms; o timeout de 25 s continua real.
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 25000 ? ms : 0, ...a);
const RealDate = Date;
let fakeNow = RealDate.parse('2026-11-27T03:00:00Z');
Date.now = () => fakeNow;

const siglas = ['PNV1100', 'PNV1314', 'PNV1404'];
const lista = `<html><body>${'<!-- -->'.repeat(20)}<table><tr><th>Sigla</th><th>Nome</th><th>Ativação</th><th>Desativação</th></tr>${siglas.map((c) => `<tr><td>${c}</td><td>Disciplina ${c}</td><td>01/01/2025</td><td></td></tr>`).join('')}</table></body></html>`;

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith('/jupDisciplinaLista')) return new Response(lista, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (u.pathname.endsWith('/obterTurma')) {
    const bytes = fs.readFileSync(new URL(`${u.searchParams.get('sgldis')}.html`, FIXTURES));
    // Cabeçalho igual ao que o Júpiter envia.
    return new Response(bytes, { headers: { 'content-type': 'text/html;charset=ISO-8859-1' } });
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

// Varredura completa da meia-noite (00:00 de Brasília) e o lote seguinte.
await tick('2026-11-27T03:00:00Z');
await tick('2026-11-27T03:05:00Z');
const d = await api('/api/monitor?semestre=2027-1');
assert.deepEqual(d.disciplinas.map((x) => x.codigo).sort(), siglas);

const vagas = (codigo, turma) => d.disciplinas.find((x) => x.codigo === codigo).turmas.filter((t) => t.codigo === turma);
const cursos = (registro) => registro.cursos.map((c) => [c.nome, c.vagas]);

// PNV1404: Optativa Livre 25 = 15 para toda a EP + 10 para qualquer unidade.
// "Qualquer Unidade da USP" é linha de curso, não um tipo de vaga a mais.
const t1404 = vagas('PNV1404', '2027150');
assert.deepEqual(t1404.map((v) => [v.categoria, v.total]), [['Optativa Livre', 25], ['Alunos Especiais', 2], ['Extracurricular', 3]]);
assert.deepEqual(cursos(t1404[0]), [['EP - para toda a Unidade', 15], ['Qualquer Unidade da USP', 10]]);
assert.deepEqual(cursos(t1404[1]), []);

// PNV1314: Obrigatória vinculada à Engenharia Naval; Optativa Livre para toda a EP.
const t1314 = vagas('PNV1314', '2027150');
assert.deepEqual(t1314.map((v) => [v.categoria, v.total]), [['Obrigatória', 60], ['Optativa Livre', 3], ['Alunos Especiais', 2], ['Extracurricular', 3]]);
assert.deepEqual(cursos(t1314[0]), [['EP - Engenharia Naval (EC-DCN)', 60]]);
assert.deepEqual(cursos(t1314[1]), [['EP - para toda a Unidade', 3], ['Qualquer Unidade da USP', 0]]);

// PNV1100: duas turmas no mesmo horário, cada uma reservada a um curso.
assert.deepEqual(vagas('PNV1100', '2027101').map(cursos), [[['EP - Engenharia Naval (EC-DCN)', 45]]]);
assert.deepEqual(vagas('PNV1100', '2027102').map(cursos), [[['EP - Engenharia de Produção (EC-DCN)', 80]]]);

// O restante da turma continua lido como antes na página real.
const [t2027101] = vagas('PNV1100', '2027101');
assert.equal(t2027101.horario, 'qua 14:00 17:40');
assert.deepEqual(t2027101.professores, ['Francisco Javier Ramírez Fernandez', 'Hernani Luiz Brinati', 'Paula Birocchi']);
assert.equal(t2027101.inicio, '2027-03-01');
assert.equal(t2027101.fim, '2027-07-07');
assert.equal(t2027101.tipoTurma, 'Teórica');
assert.equal(vagas('PNV1314', '2027150')[0].horario, 'seg 11:10 12:50 sex 13:10 14:50');

console.log('ok - páginas reais do Júpiter: tipos de vaga e cursos a que estão reservadas');
