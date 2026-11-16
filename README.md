# laço

Site responsivo em HTML, CSS e JavaScript, com autenticação Supabase e API Node.js para conversas, contatos, grupos, fotos e moderação por IP.

## Deploy no Render

1. Faça push da pasta para um repositório Git seu e crie um **Web Service** no Render usando o blueprint `render.yaml`.
2. No Render, configure as variáveis do serviço:
   - `VITE_SUPABASE_URL`: URL do seu projeto Supabase.
   - `VITE_SUPABASE_ANON_KEY`: chave pública `publishable` ou `anon`.
   - `SUPABASE_URL`: a mesma URL do projeto.
   - `SUPABASE_ANON_KEY`: a mesma chave pública `publishable` ou `anon`.
   - `SUPABASE_SERVICE_ROLE_KEY`: chave **secreta** do projeto. Guarde somente nos secrets do Render; nunca use um nome `VITE_*` para ela nem a envie ao navegador ou Git.
   - `MODERATOR_EMAILS`: e-mails de contas moderadoras separados por vírgula, por exemplo `voce@gmail.com`.
3. Use Node.js 20 ou mais recente. O Render executa `npm install && npm run build` e `npm start`.
4. No Supabase, em **Authentication → URL Configuration**, cadastre o domínio HTTPS do Render como URL autorizada. Mantenha ativa a confirmação de e-mail.

## Configuração do Supabase

Execute os arquivos no **SQL Editor**, pela ordem dos nomes:

1. `supabase/migrations/20261105000000_initial_schema.sql`
2. `supabase/migrations/20261105010000_render_ip_moderation.sql`
3. `supabase/migrations/20261105020000_admin_message_activity.sql`
4. `supabase/migrations/20261105030000_profile_customization.sql`
5. `supabase/migrations/20261105040000_nickname_friend_ids.sql`

O primeiro cria perfis, contatos, amizades, conversas, mensagens e buckets privados. O segundo cria o registro de IPv4/IPv6 e bloqueios e revoga o acesso direto às tabelas e aos objetos de armazenamento pelas credenciais do navegador. O terceiro adiciona a contagem administrativa agregada de mensagens, sem expor conteúdo ou destinatários. O quarto adiciona biografia e link ao perfil. O quinto atribui um número aleatório e exclusivo a cada perfil e habilita pedidos de amizade por apelido#número. Aplique migrations que ainda não executou, na ordem; elas podem ser executadas novamente.

Não habilite acesso público às tabelas ou aos buckets. O servidor usa a `service_role` apenas em rotas que validam a sessão e a propriedade dos recursos; não copie essa chave para o frontend.

## Desenvolvimento local

1. Copie `.env.example` para `.env` e preencha URL e chave pública do Supabase.
2. Obtenha a `service_role` nas configurações de API do Supabase e preencha `SUPABASE_SERVICE_ROLE_KEY` no `.env` local. Esse arquivo já está ignorado pelo Git e a chave secreta só é lida pelo servidor.
3. Preencha `MODERATOR_EMAILS` com seu e-mail de moderador.
4. Execute `npm install`; em terminais separados execute `npm run server` e `npm run dev`. O Vite encaminha `/api` ao servidor local.

## Endereços IP e moderação

O Render entrega o IP de origem ao servidor pelo proxy confiável; o servidor valida IPv4/IPv6, registra o endereço associado à conta nas chamadas autenticadas e nega acesso à API quando o endereço está bloqueado. Endereços completos são armazenados sem expiração no Supabase, com acesso somente pelo servidor privilegiado e pelos moderadores indicados em `MODERATOR_EMAILS`. O painel de moderação lista os endereços, exige um motivo para bloquear e permite remover um bloqueio. Um bloqueio pelo IP atual de quem modera é recusado para evitar lockout.

O site exige confirmação explícita, no cadastro e no login, de que o usuário leu o aviso sobre o registro de IP. Consulte `privacy.html`. IPs podem mudar ou ser compartilhados: um ban de rede pode bloquear terceiros inocentes, e VPNs/proxies podem contorná-lo; portanto, IP não prova a identidade nem a violação de uma pessoa. O painel de moderação mostra nomes, fotos, IPs e quantidade de mensagens por conta, mas não lê nem revela conteúdo de mensagens privadas ou seus destinatários. O responsável pelo serviço deve proteger o acesso ao Render/Supabase e revisar as obrigações legais de privacidade antes de publicar.

## Contatos, conversas e fotos

Amizades são iniciadas pelo identificador completo `apelido#123456`; apelidos podem se repetir e o número é gerado pelo banco, sem repetição entre contas. Conversas, amizades, grupos e perfil passam pelo servidor e são persistidos no Supabase. Mensagens novas atualizam a interface por consulta periódica. Fotos privadas aceitam JPG, PNG, WebP e GIF de até 10 MB (fotos de perfil: até 5 MB).

O cadastro aceita endereços de e-mail verificados pelo Supabase; o serviço padrão do Supabase ainda pode impor limites ao envio de e-mails de confirmação. O perfil permite foto, nome, biografia e um link HTTPS/HTTP, e oferece somente os temas claro e escuro em preto e branco.
