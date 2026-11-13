/**
 * Teste das funções de leitura dos cartões (public/cartoes.js), sem navegador.
 * O arquivo é um script clássico; aqui ele roda num contexto isolado do vm.
 * Uso: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../public/cartoes.js', import.meta.url), 'utf8'), ctx);
// Listas criadas dentro do vm são de outro "realm"; a cópia por JSON permite
// compará-las com deepEqual estrito.
const plain = (valor) => JSON.parse(JSON.stringify(valor));

assert.equal(ctx.formatarEncontros('seg 08:20 10:10 qua 10:00 11:40 qua 14:00 15:40'), 'seg 08:20–10:10 · qua 10:00–11:40 · qua 14:00–15:40');
assert.equal(ctx.formatarEncontros('sáb 08:00 12:00'), 'sáb 08:00–12:00');
assert.equal(ctx.formatarEncontros('Horário não informado'), 'Horário não informado');
assert.equal(ctx.formatarEncontros(''), 'Horário não informado');

assert.equal(ctx.nomeSemCodigo('PNV3412 - Sistemas Oceânicos', 'PNV3412'), 'Sistemas Oceânicos');
assert.equal(ctx.nomeSemCodigo('Sistemas Oceânicos', 'PNV3412'), 'Sistemas Oceânicos');
assert.equal(ctx.nomeSemCodigo('Disciplina PNV3412', 'PNV3412'), '');
assert.equal(ctx.nomeSemCodigo('PNV3412', 'PNV3412'), '');

assert.equal(ctx.inscritosDoJupiter({ inscritosTotal: 52, inscritos: 12, pendentes: 0, matriculados: 40 }), 52);
assert.equal(ctx.inscritosDoJupiter({ inscritos: 2, pendentes: 1, matriculados: 1 }), 4);

assert.deepEqual(['2027150', '2027102', '2027101'].sort(ctx.compararCodigos), ['2027101', '2027102', '2027150']);

const grupos = ctx.agruparTurmas([
  { codigo: '2027150', tipoTurma: 'Teórica', inicio: '2027-02-22', fim: '2027-07-03', horario: 'seg 08:20 10:10', professores: ['Marcos Mendes de Oliveira Pinto'], categoria: 'Obrigatória' },
  { codigo: '2027150', tipoTurma: 'Teórica', inicio: '2027-02-22', fim: '2027-07-03', horario: 'seg 08:20 10:10', professores: ['Marcos Mendes de Oliveira Pinto', 'Paula Birocchi'], categoria: 'Optativa Livre' },
  { codigo: '2027101', tipoTurma: '', inicio: null, fim: null, horario: 'Horário não informado', professores: [], categoria: 'Obrigatória' },
  { codigo: '2027101', tipoTurma: 'Prática', turmaTeoricaVinculada: '2027150', inicio: '2027-02-22', fim: null, horario: 'ter 10:00 11:40', professores: ['Ana Paula de Souza Lima'], categoria: 'Optativa Eletiva' }
]);
assert.deepEqual(plain(grupos.map((g) => g.codigo)), ['2027101', '2027150']);
assert.deepEqual(plain(grupos[1].professores), ['Marcos Mendes de Oliveira Pinto', 'Paula Birocchi']);
assert.deepEqual(plain(grupos[1].vagas.map((v) => v.categoria)), ['Obrigatória', 'Optativa Livre']);
assert.equal(grupos[0].horario, 'ter 10:00 11:40');
assert.equal(grupos[0].tipoTurma, 'Prática');
assert.equal(grupos[0].turmaTeoricaVinculada, '2027150');
assert.equal(grupos[0].inicio, '2027-02-22');
assert.equal(grupos[0].fim, null);
assert.deepEqual(plain(grupos[0].professores), ['Ana Paula de Souza Lima']);
console.log('ok - leitura dos cartões: encontros, nome, inscritos e agrupamento por turma');
