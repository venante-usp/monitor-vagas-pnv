/**
 * Conteúdo estático do site (sem navegador): as abas que existem e o texto
 * escrito com "-" em vez de travessão. Uso: npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PUBLICO = new URL('../public/', import.meta.url);
const ler = (arquivo) => fs.readFileSync(new URL(arquivo, PUBLICO), 'utf8');
const pagina = ler('index.html');

// Abas do site: Monitor, Histórico e Desativadas. A aba Grade horária, com a
// impressão da grade e o arquivo DOCX, não existe mais.
const abas = Array.from(pagina.matchAll(/class="view-tab[^"]*" data-view="([^"]+)"/g), (achado) => achado[1]);
assert.deepEqual(abas, ['monitor', 'historico', 'desativadas']);
for (const resto of ['data-view="grade"', 'gradeView', 'Grade horária', 'printDocument', 'printSchedule', '@media print', 'docxDialog', 'generateDocx', 'DOCX', 'curriculo']) {
  assert.ok(!pagina.includes(resto), `sobrou da aba Grade horária: ${resto}`);
}

// Todo texto do site usa "-" no lugar de travessão (— e –), inclusive o que o
// JavaScript monta, como os horários "seg 11:10-12:50". O travessão também
// chegaria à tela escrito como escape (—) ou entidade (&mdash;); escapes só
// aparecem nas classes das expressões que leem o Júpiter, que começam por
// hífen: [-–—·:].
const CLASSE_DE_LEITURA = /\[-(?:\\u201[34])+[^\]\n]*\]/g;
const TRAVESSAO_ESCRITO = /\\u201[34]|\\u\{201[34]\}|&[mn]dash;|&#821[12];|&#x201[34];/i;
const comTravessao = [];
for (const arquivo of fs.readdirSync(PUBLICO)) {
  ler(arquivo).split('\n').forEach((linha, indice) => {
    if (/[–—]/.test(linha) || TRAVESSAO_ESCRITO.test(linha.replace(CLASSE_DE_LEITURA, ''))) comTravessao.push(`public/${arquivo}:${indice + 1}`);
  });
}
assert.deepEqual(comTravessao, [], `travessão em ${comTravessao.join(', ')}`);

console.log('ok - site: abas Monitor, Histórico e Desativadas, texto sem travessão');
