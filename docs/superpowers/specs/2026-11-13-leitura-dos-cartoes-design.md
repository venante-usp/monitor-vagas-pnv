# Leitura dos cartões do monitor — design

Data: 13/11/2026 · Tamanho: mudança pequena · Aprovado pela coordenação no chat.

## Intenção

Quem usa o site é a coordenação. Depois de cadastrar as turmas no Júpiter, ela
confere **manualmente** o que aparece no monitor contra a planilha interna de
planejamento (disciplinas, turmas, horários, professores, tipos de vaga, cursos
e ocupação). O objetivo é deixar os cartões atuais mais fáceis de ler e de bater
com a planilha e com o próprio Júpiter, sem mudar a estrutura da tela.

## Objetivos

- Cada turma aparece **uma vez** dentro do cartão da disciplina, com código,
  tipo da turma, datas de início e fim, horário e professores.
- Os tipos de vaga viram linhas de uma pequena tabela com as **mesmas colunas
  do Júpiter**: Vagas, Inscritos, Pendentes, Matriculados, e uma coluna Livres.
  Os cursos/unidades ("Reservadas para") aparecem logo abaixo do tipo a que
  pertencem, recuados, como no Júpiter.
- "Inscritos" no cartão tem o **mesmo sentido do Júpiter** (o total), para os
  números baterem direto com a página do Júpiter.
- Encontros da semana separados: `seg 08:20–10:10 · qua 10:00–11:40`.
- Nome da disciplina sem o código repetido (`PNV3412 · Sistemas Oceânicos`).
- Disciplinas e turmas em **ordem de código**, como numa planilha.

## Não objetivos

- Comparação automática com a planilha (a coordenação prefere conferir à mão).
- Nova visão em tabela ou redesenho da página.
- Mudanças nas abas Grade horária, Histórico e Desativadas, no seletor de
  semestre, nos filtros, na impressão e no DOCX.

## Antiobjetivos

- Mostrar no cartão um número diferente do que o Júpiter mostra para o mesmo
  campo.
- Esconder qualquer dado que o Júpiter mostra e que hoje o cartão exibe.

## Restrições

- Página estática única (`public/index.html`), JavaScript inline, sem
  bibliotecas externas; dados de `/api/monitor`.
- Precisa funcionar com dados já gravados (ex.: 2026/2 congelado), que não têm
  `inscritosTotal`: nesses casos o total do Júpiter é reconstruído como
  aguardando + pendentes + matriculados (o mesmo valor que o Júpiter mostrava).
- Largura de celular sem rolagem horizontal da página (a tabela de vagas pode
  rolar dentro do próprio quadro, se necessário).

## Abordagens consideradas

1. **Reorganizar o conteúdo de cada cartão (escolhida).** Mantém a tela que a
   coordenação já usa e ataca o que atrapalha a leitura: repetição por tipo de
   vaga, números com sentido diferente do Júpiter e ordem imprevisível.
2. Nova visão em tabela, uma linha por turma — descartada: muda a tela que a
   coordenação usa hoje.
3. Comparação automática com a planilha — descartada: a coordenação quer
   conferir manualmente.

## Decisões

- Agrupamento por código da turma; dentro do grupo, os tipos de vaga na ordem
  em que o Júpiter os lista; os cursos abaixo de cada tipo.
- A API passa a entregar `inscritosTotal` em cada registro de vaga e em cada
  curso (reconstruído para dados antigos).
- Cabeçalho do cartão: código · nome e o total de pessoas (soma de "Inscritos"
  do Júpiter nas turmas).
- Status (vagas / poucas / lotada) passa a ser exibido por tipo de vaga, na
  coluna Livres.

## Deixado para quem implementar

- Espaçamentos, cores e tipografia, seguindo os tokens existentes da página.
- Filtros "Com vagas / Poucas / Sem vagas": mantêm o comportamento atual (a
  disciplina aparece se algum tipo de vaga atende ao filtro) e o cartão mostra
  todas as turmas, para a conferência ficar completa.

## Pendência anotada

O Histórico continua chamando de "Inscritos" a série de quem aguarda vaga (sem
pendentes e matriculados), o que difere do "Inscritos" do Júpiter usado agora no
cartão. Alinhar esse rótulo fica para depois, se a coordenação quiser.
