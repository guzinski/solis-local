# Refinamento de layout e próximos dados do sistema

## Propostas para revisão

- **A — Ajuste fino:** preserva ordem, cartões, gráficos e hierarquia atuais.
  Usa uma barra compacta e deixa os detalhes de equipamento recolhidos no fim.
  É a proposta mais próxima do pedido de manter quase tudo como está.
- **B — Resumo e sistema:** mantém os mesmos gráficos, aproxima potência e
  energia de hoje e leva as informações técnicas para uma aba Sistema. Faz
  mais sentido quando o volume de dados de equipamento crescer.

Abrir `public/design/index.html` pelo servidor existente, ou usar diretamente
`/design/version-a.html` e `/design/version-b.html`. Não executar os arquivos por
`file://`, pois os gráficos usam módulos JavaScript.

Todos os números são demonstrativos. Os protótipos não fazem chamadas à API,
ao stick ou ao Modbus. Tema, período dos gráficos, menu, navegação e simulação
de estados são interativos. Campos desconhecidos continuam explicitamente
marcados como não consultados; não se mostra “sem alarmes” por dedução.

## Ajuste comum do cabeçalho Android

O cabeçalho anterior combinava um texto de 52 dp, padding vertical e um Button
padrão para o menu. O título também não tinha centralização vertical explícita.
O ajuste usa uma barra de 48 dp, título centralizado e um ImageButton sem fundo
visível, mantendo uma área de toque de 48 × 48 dp. As margens das barras do
sistema são aplicadas pelo contêiner raiz e consumidas antes dos filhos para
evitar aplicação duplicada dentro da WebView.

Esse ajuste é comum às propostas e já está no APK; a reorganização A/B do painel
web permanece apenas como protótipo. Referência de comportamento de insets:
[documentação Android sobre edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge).

## O que já conseguimos mostrar sem novas consultas

As leituras atuais **já são dados do inversor, recebidos através do stick**.
O stick atua como ponte. O código em `src/inverter.ts` lê um bloco FC04 de 46
registros a partir do endereço de fio 2999.

| Informação | Fonte atual | Observação |
| --- | --- | --- |
| Potência AC e entrada DC | Bloco de leitura atual | Já armazenadas e exibidas |
| Tensão e corrente das duas strings | Mesmo bloco | Já disponíveis |
| Temperatura, tensão e frequência da rede | Mesmo bloco | O endereço de tensão está documentado como inferido; precisa continuar identificado no mapa técnico |
| Estado bruto do inversor | Mesmo bloco | Não equivale a uma leitura completa de alarmes |
| Energia diária, mensal, anual e acumulada | Mesmo bloco | Já disponíveis |
| Última leitura, duração, erro e reuso de conexão | Logs locais de tentativas | Podem alimentar um resumo de comunicação sem gerar tráfego novo no equipamento |
| Endereço em uso, porta e intervalo | Configuração/estado do monitor | Mostrar apenas no painel privado; não gravar valores reais em exemplos ou protótipos |

Primeiro passo funcional: agrupar esses dados já existentes em Sistema. Não
precisamos aumentar a frequência de polling para fazer isso.

## Dados novos: confirmar a origem antes de implementar

| Equipamento | Dados desejados | Caminho a validar |
| --- | --- | --- |
| Stick | Modelo, firmware, número de série | Página local autenticada ou interface documentada do modelo; não assumir que os registros do inversor descrevem o stick |
| Stick | Qualidade do sinal, uptime, reinicializações | Somente se houver uma fonte local confirmada; não inferir de tempos de resposta |
| Inversor | Modelo, série e versões de firmware | Mapa de registros correspondente ao modelo e revisão do protocolo |
| Inversor | Alarmes ativos, códigos e severidade | Registros/bitfields documentados para o equipamento; um estado “gerando” não prova ausência de alarmes |

A documentação Solis confirma FC04 como leitura de informações, mas sua página
genérica não identifica os endereços de todos esses campos para o equipamento
instalado. Não reutilizar mapas de híbridos ou de outra geração por semelhança.
[Referência do fabricante](https://developer.soliscloud.com/guide/modbus.html).

Identificadores pouco variáveis devem ser lidos de forma pontual e armazenados,
usando a conexão existente e consultas serializadas, após validar o mapa. Não
criar um segundo cliente Modbus. Consultas de alarmes precisam de cadência
definida a partir da estabilidade observada, com registro de cada tentativa.
Essa fase não inclui comandos de escrita, alteração de parâmetros ou buscas
exploratórias de registradores no equipamento em operação.

## Três estados distintos na interface

1. **App → painel:** o computador/gateway está acessível? O usuário está em casa
   ou pela VPS? Isso não informa se o inversor está gerando.
2. **Painel → stick:** há resposta de rede/web e da porta Modbus? Informar
   observação e horário, sem usar “online” como prova de funcionamento completo.
3. **Stick → inversor:** há leitura recente dos registros? Qual estado bruto e
   quais alarmes foram efetivamente obtidos?

Uma página web acessível com Modbus indisponível é uma observação de
comunicação. Não confirma, isoladamente, travamento, repouso ou falta de sol.
Um valor antigo também não deve parecer uma medição atual. Mostrar a idade da
leitura e manter “desconhecido/não consultado” quando faltar informação.
