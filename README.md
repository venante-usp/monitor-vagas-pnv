# Monitor de vagas PNV — Cloudflare Free

Monitor automático de disciplinas PNV: o navegador apenas lê os dados do KV. Somente o cron da Cloudflare e o processo de deploy podem consultar o Júpiter.

## Atualização automática

- A cada 5 minutos: atualização 1curta de até 3 disciplinas já ofertadas.
- À 00:00 de Brasília: começa a varredura completa da lista oficial PNV do Júpiter; cada execução processa até 5 códigos em ritmo lento e com tentativas.
- Depois de cada deploy: a publicação consulta imediatamente a lis6ta oficial do Júpiter e c6ria uma nova fila de varredura completa. O primeiro lote é processado pelo próximo cron de 5 minutos.

Nenhum visitante consegue disparar atualização.

## Ciclo semestral automático

O site separa as turmas por semestre e cuida sozinho da troca de semestre — não há nada para configurar a cada período.

| Situação | O que acontece |
|---|---|
| **Ao vivo** | A disciplina aparece no Júpiter e é atualizada pelo cron. |
| **Congelado** | O Júpiter passou a responder *"Não existe oferecimento para a sigla…"* (o que acontece antes do fim do semestre). O último retrato confirmado continua visível, marcado como congelado. |
| **Aguardando cadastro** | O próximo semestre aparece como aba vazia ~75 dias antes do fim do atual. Enquanto nenhuma turma estiver viva, a atualização curta percorre a lista oficial inteira (3 siglas a cada 5 min) para detectar a primeira turma nova. |
| **Arquivado** | 14 dias depois do *Fim* das turmas (ou 60 dias, se o Júpiter nunca retirar a oferta) o semestre é gravado em `monitor:semestre:arquivo:v1:AAAA-S` no KV e sai das abas, ficando no seletor **Arquivo**. |

O semestre de cada turma vem das datas **Início/Fim** que o Júpiter publica em cada turma (com o código da turma `AAAAS##` como alternativa). Por isso turmas do semestre corrente e do seguinte nunca se misturam, mesmo quando aparecem ao mesmo tempo. Sem datas, usa-se o calendário (1º: fev–jul, 2º: ago–dez).

Por padrão o site abre no semestre mais novo com turmas vivas (ex.: período de matrícula); se não houver, no semestre em andamento. Qualquer semestre pode ser aberto por link: `/?semestre=2026-2`.

A API aceita o mesmo parâmetro: `GET /api/monitor?semestre=AAAA-S` e devolve também `semestres` (abas ativas), `arquivo` e `semestrePadrao`.

Para conferir o ciclo localmente, sem rede: `npm test`.

## Configuração adicional obrigatória para a sincronização pós-deploy
4
O deploy executa `wrangler deploy` e, logo depois, cha3ma uma rota administrativa protegida. Você pre4cisa configurar o mesmo segredo em dois lugares.

### 1. Segredo de execução do Worker

No Cloudflare Dashboard: **Workers & Pages → monitor-vagas-pnv → Settings → Variables and Secrets → Add**.

- Tipo: **Secret**
- Nome: `DEPLOY_SYNC_TOKEN`
- Valor: uma senha longa e aleatória (use pelo menos 32 caracteres)

### 2. Variáveis do ambiente de build

No mesmo Worker: **Settings → Environment variables** (ou **Build → Build Variables and Secrets**, dependendo do layout do painel).

Crie estes dois valores:

| Nome | Tipo | Valor |
|---|---|---|
| `DEPLOY_SYNC_URL` | Plain text | `https://SEU-SUBDOMINIO.workers.dev/internal/sincronizar-apos-deploy` |
| `DEPLOY_SYNC_TOKEN` | Secret | exatamente o mesmo valor definido no passo 1 |

Exemplo: se o site público é `https://monitor-vagas-pnv.vitor.workers.dev`, o valor da URL será `https://monitor-vagas-pnv.vitor.workers.dev/internal/sincronizar-apos-deploy`.

Com o Workers Builds conectado ao GitHub, deixe o **Deploy command** como `npm run deploy`. Cada commit na branch de produção publicará o Worker e iniciará a fila de consulta sem qualquer ação do visitante.

## Arquivos que não devem receber segredo

Nunca coloque o token em `wrangler.jsonc`, JavaScript do navegador, commits do GitHub ou URLs compartilhadas.
