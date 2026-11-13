# Leitura dos cartões do monitor — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganizar o conteúdo de cada cartão de disciplina para a coordenação conferir o cadastro do Júpiter contra a planilha: uma vez por turma, tabela de vagas com as colunas do Júpiter, cursos abaixo de cada tipo, encontros separados, nome sem código repetido e ordem por código.

**Architecture:** A API (`src/worker.js`) passa a entregar o total de inscritos do Júpiter (`inscritosTotal`) em cada registro de vaga e em cada curso. Funções puras de leitura (agrupar registros por turma, formatar encontros, limpar o nome) ficam em `public/cartoes.js`, um script clássico testável com `node:vm`. O `render()` de `public/index.html` usa essas funções para montar o novo cartão; o resto da página não muda.

**Tech Stack:** Cloudflare Worker (JavaScript ES modules), página estática com JavaScript inline sem bibliotecas, testes com `node:assert` e `node:vm`, verificação visual com Playwright (já instalado no ambiente, fora do `npm test`).

**Spec:** `docs/superpowers/specs/2026-11-13-leitura-dos-cartoes-design.md`

## Global Constraints

- Sem bibliotecas externas; `public/cartoes.js` é script clássico (sem `import`/`export`), carregado antes do script inline.
- "Inscritos" no cartão = total do Júpiter: `inscritosTotal`; registros antigos sem esse campo: `inscritos + pendentes + matriculados`.
- Colunas da tabela, nesta ordem e com este texto: `Tipo de vaga / curso`, `Vagas`, `Inscr.`, `Pend.`, `Matric.`, `Livres`.
- Encontros no formato `seg 08:20–10:10 · qua 10:00–11:40` (traço U+2013 entre as horas, ` · ` entre encontros).
- Ordem por código com `String(a).localeCompare(String(b), 'pt-BR', { numeric: true })`, para disciplinas e turmas.
- Abas, filtros, seletor de semestre, grade horária, histórico, desativadas, impressão e DOCX não mudam.
- Largura de 390px sem rolagem horizontal da página (a tabela pode rolar dentro do próprio quadro).

## Review Focus

1. Registros antigos sem `inscritosTotal` (2026/2 congelado): a coluna `Inscr.` mostra o total reconstruído (ex.: 2 aguardando + 1 pendente + 1 matriculado = 4) — testes na Task 1 e na Task 2.
2. Turma com vários registros em que só alguns trazem professores, horário ou datas: professores unidos sem repetição; horário e datas do primeiro registro que os tiver — teste na Task 2.
3. Horário sem encontro reconhecível ("Horário não informado" ou texto livre): exibido como veio, sem quebrar — teste na Task 2.
4. Nome que é só o código ou o reserva `Disciplina PNV3412`: o cabeçalho mostra só o código, sem ` · ` solto — teste na Task 2.
5. Celular (390px) com nomes de curso longos e seis colunas: nenhuma rolagem horizontal da página — verificação na Task 3.

---

### Task 1: API entrega o total de inscritos do Júpiter

**Files:**
- Modify: `src/worker.js` (`normalizarTurmaParaResposta`)
- Test: `test/leitura-jupiter.test.mjs`

**Interfaces:**
- Produces: em `/api/monitor`, cada item de `disciplinas[].turmas[]` tem `inscritosTotal: number`, e cada item de `turmas[].cursos[]` também tem `inscritosTotal: number`.

- [ ] **Step 1: Write the failing test** — em `test/leitura-jupiter.test.mjs`, ao fim da seção 1 (dados antigos):

```js
assert.equal(t3412[1].inscritosTotal, 4, 'total do Júpiter reconstruído: 2 + 1 + 1');
assert.equal(t3412[1].cursos[0].inscritosTotal, 4);
assert.equal(t3100.inscritosTotal, 55);
```

e ao fim da seção 2 (página nova):

```js
assert.equal(obrig.inscritosTotal, 52);
assert.equal(livre.inscritosTotal, 3);
assert.equal(obrig.cursos[0].inscritosTotal, 52);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/leitura-jupiter.test.mjs`
Expected: FAIL com `undefined !== 4` na primeira asserção nova.

- [ ] **Step 3: Implement `inscritosTotalDoRegistro(registro) -> number` em `src/worker.js`** — devolve `Number(registro.inscritosTotal)` quando o campo existe e é número finito; senão `inscritos + pendentes + matriculados` de `normalizarContagemTurma(registro)`. Em `normalizarTurmaParaResposta`, acrescentar `inscritosTotal: inscritosTotalDoRegistro(turma)` e `cursos: (turma.cursos || []).map((curso) => ({ ...curso, inscritosTotal: inscritosTotalDoRegistro(curso) }))`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: as duas linhas `ok - …`.

- [ ] **Step 5: Commit**

```bash
git add src/worker.js test/leitura-jupiter.test.mjs
git commit -m "API entrega o total de inscritos do Júpiter em cada vaga e curso"
```

### Task 2: Funções de leitura dos cartões

**Files:**
- Create: `public/cartoes.js`
- Create: `test/cartoes.test.mjs`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Produces (funções globais no navegador e no contexto do `vm`):
  - `compararCodigos(a: string, b: string): number`
  - `formatarEncontros(horario: string): string`
  - `nomeSemCodigo(nome: string, codigo: string): string`
  - `inscritosDoJupiter(registro: object): number`
  - `agruparTurmas(registros: object[]): Array<{ codigo: string, tipoTurma: string, turmaTeoricaVinculada: string|null, inicio: string|null, fim: string|null, horario: string, professores: string[], vagas: object[] }>` — um item por código de turma, em ordem de código; `vagas` são os registros originais na ordem recebida.

- [ ] **Step 1: Write the failing test** — `test/cartoes.test.mjs` carrega o arquivo com `vm.createContext({})` + `vm.runInContext(fs.readFileSync(new URL('../public/cartoes.js', import.meta.url), 'utf8'), ctx)` e verifica:

```js
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
assert.deepEqual(grupos.map((g) => g.codigo), ['2027101', '2027150']);
assert.deepEqual(grupos[1].professores, ['Marcos Mendes de Oliveira Pinto', 'Paula Birocchi']);
assert.deepEqual(grupos[1].vagas.map((v) => v.categoria), ['Obrigatória', 'Optativa Livre']);
assert.equal(grupos[0].horario, 'ter 10:00 11:40');
assert.equal(grupos[0].tipoTurma, 'Prática');
assert.equal(grupos[0].turmaTeoricaVinculada, '2027150');
assert.equal(grupos[0].inicio, '2027-02-22');
assert.equal(grupos[0].fim, null);
assert.deepEqual(grupos[0].professores, ['Ana Paula de Souza Lima']);
console.log('ok - leitura dos cartões: encontros, nome, inscritos e agrupamento por turma');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/cartoes.test.mjs`
Expected: FAIL com `ENOENT` para `public/cartoes.js`.

- [ ] **Step 3: Implement the five functions in `public/cartoes.js`** — encontros reconhecidos pela regex `/\b(seg|ter|qua|qui|sex|s[aá]b|dom)\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/gi`; sem nenhum, devolve o texto normalizado ou `Horário não informado` se vazio. `nomeSemCodigo` remove o código e separadores no início (`-`, `–`, `·`, `:`) e trata `Disciplina <código>` como vazio. Em `agruparTurmas`, o horário do grupo é o do primeiro registro com encontro reconhecível, depois o primeiro não vazio; `tipoTurma`, `turmaTeoricaVinculada`, `inicio` e `fim` são o primeiro valor não vazio (ou `''`/`null`); professores unidos sem repetição, na ordem.

- [ ] **Step 4: Run test to verify it passes, then add it to `npm test`**

Run: `node test/cartoes.test.mjs` → `ok - leitura dos cartões…`. Depois, em `package.json`, o script `test` passa a ser `node test/ciclo-semestral.test.mjs && node test/leitura-jupiter.test.mjs && node test/cartoes.test.mjs`; `npm test` mostra três linhas `ok - …`.

- [ ] **Step 5: Commit**

```bash
git add public/cartoes.js test/cartoes.test.mjs package.json
git commit -m "Funções de leitura dos cartões: turmas agrupadas, encontros e nome"
```

### Task 3: Novo cartão da disciplina

**Files:**
- Modify: `public/index.html` — `<script src="cartoes.js"></script>` antes do `<script>` inline; `render()`; CSS do cartão; `htmlCursosDaVaga` substituída pelas linhas de curso da tabela (`nomeCursoCurto` continua).

**Interfaces:**
- Consumes: `inscritosTotal` (Task 1) e `compararCodigos`, `formatarEncontros`, `nomeSemCodigo`, `inscritosDoJupiter`, `agruparTurmas` (Task 2); `status`, `normT`, `totalPessoas`, `formatDateBr`, `escapeHtml`, `number` já existentes.

- [ ] **Step 1: Rewrite the card markup in `render()`**, mantendo filtro, contagem e mensagem de vazio como estão:
  - disciplinas ordenadas por `compararCodigos(a.codigo, b.codigo)`;
  - cabeçalho: código, ` · ` + `nomeSemCodigo(d.nome, d.codigo)` só se não vazio, e à direita `<strong>N</strong> pessoas` com `N = totalPessoas(d).pessoas`; o selo "Congelada" da situação parcial continua; a linha "Inscritos · Pendentes · Matriculados" do cabeçalho sai;
  - para cada item de `agruparTurmas(d.turmas)`: linha `Turma <código>` + ` · <tipoTurma>` + ` · vinculada à teórica <código>` + ` · <início> a <fim>` (cada parte só se existir); linha com `formatarEncontros(horario)`; linha `Prof.: …` ou `Prof.: não informado no Júpiter`;
  - tabela com os seis cabeçalhos da seção Global Constraints; linha de tipo: `categoria`, `total`, `inscritosDoJupiter(v)`, `pendentes`, `matriculados` e, em Livres, `lotada` (classe `bad`) quando `status(v)==='lotadas'`, senão `normT(v).disponiveis` com classe `warn` (`poucos`) ou `ok`; abaixo, uma linha recuada por curso com `nomeCursoCurto(nome)` (nome completo no `title`), `vagas`, `inscritosDoJupiter(curso)`, `pendentes`, `matriculados` e Livres vazio.

- [ ] **Step 2: Add the CSS** — classes `.turma`, `.turma-head`, `.turma-horario`, `.vagas-scroll` (`overflow-x:auto`), `.vagas-tabela`, `.vaga-tipo`, `.vaga-curso` (recuo e texto mais leve), números alinhados à direita com `font-variant-numeric:tabular-nums`; remover as regras que ficarem sem uso (`.quota*`, `.breakdown`, `.vacancies`, `.details`, `.class*`, `.schedule`), conferindo com `grep` que nenhuma outra parte da página as usa.

- [ ] **Step 3: Verify in the browser** — servidor de prévia com os dados de `test/leitura-jupiter.test.mjs` servindo também `/cartoes.js`, e Playwright em 1200px e 390px:

Expected:
  - semestre 2027-1, cartão PNV3412: cabeçalho `PNV3412 · Sistemas Oceânicos` e `55 pessoas`; um único bloco `Turma 2027150 · Teórica · 22/02/2027 a 03/07/2027`; encontros `seg 08:20–10:10 · qua 10:00–11:40 · qua 14:00–15:40`; linhas `Obrigatória 47 52 0 40 lotada`, `Engenharia Naval 47 52 0 40`, `Optativa Livre 5 3 1 1 2`, `Qualquer Unidade da USP 5 3 1 1`;
  - semestre 2026-2: cartões em ordem `PNV3100`, `PNV3412`; turma 2026250 com `Obrigatória 47 47 0 47 lotada` e `Optativa Livre 5 4 1 1 1`;
  - `document.documentElement.scrollWidth` igual a 1200 e a 390; nenhum erro de página.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: três linhas `ok - …`.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Cartão da disciplina: uma vez por turma, tabela de vagas como no Júpiter"
```

## Entrega

Push do branch `claude/friendly-dijkstra-19taew` e atualização da descrição do PR aberto (venante-usp/monitor-vagas-pnv#4) com a nova seção sobre os cartões.
