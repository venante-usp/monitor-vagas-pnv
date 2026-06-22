# Monitor de vagas PNV — Cloudflare Free

Monitor automático de disciplinas PNV: o navegador apenas lê os dados do KV. Somente o cron da Cloudflare e o processo de deploy podem consultar o Júpiter.

## Atualização automática

- A cada 5 minutos: atualização 1curta de até 3 disciplinas já ofertadas.
- À 00:00 de Brasília: começa a varredura completa da lista oficial PNV do Júpiter; cada execução processa até 5 códigos em ritmo lento e com tentativas.
- Depois de cada deploy: a publicação consulta imediatamente a lista oficial do Júpiter e c6ria uma nova fila de varredura completa. O primeiro lote é processado pelo próximo cron de 5 minutos.

Nenhum visitante consegue disparar atualização.

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
