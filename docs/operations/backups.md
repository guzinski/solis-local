# Backup diário do histórico Solar

O banco configurado por `DB_PATH` (padrão `data/solar.db`) contém leituras,
valores de cada entrada, totais e logs de conexão. Não contém os certificados
de pareamento Android, arquivos `.env` ou capturas de rede. Esta rotina protege
os dados históricos; não é uma cópia completa da instalação.

## Rotina local

`npm run backup` cria uma cópia consistente pelo mecanismo online do SQLite,
incluindo transações já confirmadas no WAL sem interromper o monitor. Valida a
cópia com `PRAGMA quick_check`, compacta em gzip e informa o SHA-256. Mantém as
30 cópias locais mais recentes em `data/backups`, com permissões privadas.

Instalar: `bash scripts/install-backup-service.sh`. O timer do usuário executa
às 03:15 no fuso do sistema, com até cinco minutos de variação. `Persistent=true`
executa um backup perdido na próxima ativação do timer. O Windows/WSL precisa
estar em execução; um computador desligado não consegue enviar backups.

Verificar:

```sh
systemctl --user list-timers solar-backup.timer
systemctl --user status solar-backup.service
journalctl --user -u solar-backup.service -n 30
```

## Cloudflare R2

1. Criar um bucket privado, sem acesso público, e credenciais S3 de Object Read
   & Write restritas a esse bucket.
2. Copiar `deploy/backup.env.example` para `.env.backup.local` e aplicar
   `chmod 600 .env.backup.local`.
3. Preencher endpoint, bucket e credenciais localmente; não enviar segredos no
   chat nem adicioná-los ao Git. Alterar `BACKUP_R2_ENABLED=true`.
4. Executar `npm run backup` e confirmar **R2 upload completed**. Uma falha de
   envio retorna erro, mas preserva a cópia local já criada.
5. Configurar no bucket uma regra de ciclo de vida para o prefixo `solar/`,
   expirando objetos após 90 dias. A rotina não apaga objetos remotamente.

Os arquivos usam nomes únicos por execução, `solar/solar-DATA.db.gz`; o hash da
cópia compactada fica nos metadados `sha256` do objeto. Um upload pendente não é
reenviado automaticamente: a próxima execução cria e envia uma nova cópia
completa, incluindo todo o histórico então disponível. Conferir o journal para
identificar falhas de envio.

A rotina usa o cliente S3 oficial com o endpoint compatível do R2:
[documentação Cloudflare](https://developers.cloudflare.com/r2/objects/upload-objects/).
O snapshot usa a API de [backup do SQLite no Node](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html#sqlitebackupsourceDb-path-options).

## Testar restauração

Baixar uma cópia do bucket (ou usar uma cópia local), comparar seu SHA-256 com o
hash registrado e descompactá-la em um arquivo novo:

```sh
sha256sum solar-DATA.db.gz
gzip -dc solar-DATA.db.gz > /tmp/solar-restore-check.db
node --disable-warning=ExperimentalWarning --input-type=module -e '
import {DatabaseSync} from "node:sqlite";
const db = new DatabaseSync("/tmp/solar-restore-check.db", {readOnly:true});
console.log(db.prepare("PRAGMA quick_check").all());
console.log(db.prepare("SELECT COUNT(*) AS readings, MIN(ts) AS first, MAX(ts) AS last FROM readings").get());
db.close();'
```

Para restaurar em produção: parar o serviço de backup/timer e o monitor, guardar
a versão atual do banco junto de seu WAL/SHM em outro diretório, instalar a
cópia validada no `DB_PATH`, sem reutilizar WAL/SHM antigos, e iniciar o monitor
e o timer. Nunca substituir o banco com o monitor ainda em execução.
