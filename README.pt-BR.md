# Context Prune

**Português** · [English](README.md)

Plugin do Claude Code (app desktop) para retomar conversas longas gastando
menos tokens depois que a conversa esfriou. Ele apaga do histórico os turnos
que já não fazem sentido para a conversa, por exemplo:

- a instalação e a configuração de um programa (um MCP que só funcionou na
  terceira tentativa);
- a depuração de um bug pontual que já foi corrigido;
- sondas, testes descartáveis e confirmações como "pronto" ou "funcionou";
- tentativas que foram trocadas por outra solução;
- prints que já foram lidos e não precisam mais ir em cada requisição.

No lugar fica uma linha curta dizendo o que saiu, sem resumo e sem chamar o
modelo. Tanto você quanto o Claude marcam os turnos que vão sair. A poda roda
sozinha quando a conversa completa 1 h parada: o cache do prompt expirou, e a
próxima mensagem gravaria a conversa inteira de novo de qualquer jeito.

- [O que ele faz](#o-que-ele-faz)
  - [Status do cache](#status-do-cache)
  - [O painel /prune](#o-painel-prune)
  - [Prints](#prints)
  - [Marcas do Claude](#marcas-do-claude)
  - [Poda automática](#poda-automática)
  - [Quanto custa podar](#quanto-custa-podar)
  - [Idioma](#idioma)
- [Instalação](#instalação)
- [Como funciona por dentro](#como-funciona-por-dentro)
- [Limitações conhecidas](#limitações-conhecidas)
- [Desenvolvimento](#desenvolvimento)
- [Licença](#licença)

## O que ele faz

### Status do cache

Ao lado do seletor de modelo aparece um destes:

- `Conversa está quente - N min restantes`: a última resposta foi há menos de
  1 h, e a próxima mensagem lê a conversa do cache (barato).
- `Conversa está fria - /prune recomendado`: passou 1 h. A próxima mensagem
  grava a conversa inteira de novo, então é a hora de podar sem custo extra.

A cada prompt, o modelo recebe uma linha com o tamanho do contexto
(`context-prune: context 355k / 1M (35%) tokens.`). O estado do cache não vai
junto, porque a decisão de podar é do usuário.

### O painel /prune

`/prune` abre o painel **Podar contexto**, com um item por turno. Um turno é o
seu pedido e tudo o que veio em resposta: o texto, o raciocínio do modelo e
as ferramentas com os resultados. Cada item mostra o peso em tokens e o começo
do prompt.

- Clicar num item marca ou desmarca. `[x]` é marca sua; `[C]`, do Claude.
- **Podar Agora** aplica as marcas na hora. **Desmarcar Todos** limpa tudo.
- Os turnos marcados viram uma linha só, e é ela que o modelo lê:
  `[removido: 5 turnos (pedidos do usuário e respostas do Claude): ok, roda um comando… | como eu escolho… | …]`.
  Turnos marcados que parecem vizinhos no painel viram uma linha só. Os
  comandos escondidos entre eles, como `/prune` e a resposta dele, saem junto.
  Podar de novo uma linha `[removido: …]` soma a contagem.
- Peso sem `~`: medido quando o turno terminou. Com `~`: estimado (texto e
  raciocínio pelo tamanho, imagens pela resolução).
- As marcas ficam guardadas e sobrevivem ao reinício do Claude.

### Prints

Cada imagem da conversa (print colado ou devolvido por uma ferramenta) tem a
própria linha no painel, logo acima do prompt em que veio:

```
[ ] ~1.5k [imagem anexada]
[ ]   448 agora acabei de mandar uma mensagem c...
```

Marcar a imagem tira só a imagem: o texto da mensagem fica, com
`[print removido]` no lugar. Marcar o prompt tira o turno inteiro, imagem
junto. Um prompt que é só imagem aparece como um item só, `[imagem anexada]`.

### Marcas do Claude

O Claude tem uma ferramenta, `prune_marks`, para marcar turnos que já não
servem, como configuração resolvida, depuração, sondas e confirmações de teste.
A lista de turnos e marcas chega a ele só quando ele usa a ferramenta, não em
toda mensagem. Ele só desmarca as próprias marcas; as suas ficam como você
deixou. As marcas dele aparecem como `[C]` no painel, e você desmarca o que
quiser manter.

### Poda automática

O que estiver marcado espera a conversa esfriar. Quando ela completa 1 h
parada, o plugin poda sozinho e avisa quantos turnos e prints saíram. A próxima
mensagem, seja qual for (texto, print ou anexo), já sai com a conversa podada.

Com o Claude fechado, a poda roda alguns segundos depois de você abrir a
conversa de novo. Se uma mensagem de texto chegar antes disso, o plugin a segura
(o app mostra "Prompt bloqueado por um hook"), poda e reenvia o texto como
seu.

### Quanto custa podar

O cache guarda a conversa como uma sequência. Depois de uma poda, o que vem
antes do primeiro corte continua no cache; o que vem depois é gravado de novo
na mensagem seguinte. Com o cache de 1 h, gravar custa 2x e ler custa 0,1x.

- **Conversa fria:** a próxima mensagem grava tudo de qualquer jeito. Podar só
  diminui o que é gravado.
- **Conversa quente:** podar agora regrava o que vem depois do 1º corte a 2x.
  Só compensa se a conversa for continuar por muitas requisições, ou se o
  contexto estiver perto do limite. O painel mostra essa conta antes de você
  apertar.

### Idioma

O plugin fala inglês ou português; o padrão é inglês. Para trocar, mande
`/prune pt` ou `/prune en`, ou aperte o ⚙ no topo do painel, à direita da barra. A escolha vale
para todas as conversas.

Muda o que você lê: o status, o painel, os avisos e as linhas que a poda deixa
(`[removido: …]` ou `[removed: …]`, `[print removido]` ou
`[screenshot removed]`). As linhas que já estão na conversa ficam como foram
escritas, e uma poda seguinte soma a contagem delas em qualquer idioma. O que
só o Claude lê (a ferramenta de marcas) fica em inglês.

## Instalação

Num terminal com o Claude Code, ou no app desktop, digite:

```text
/plugin install context-prune --marketplace uayten/ContextPrune
```

Em duas etapas, ou em versões anteriores à 2.1.275:

```text
/plugin marketplace add uayten/ContextPrune
/plugin install context-prune@fofuxo-context-prune
```

Testado no app desktop, versão 2.1.299.

## Como funciona por dentro

A poda é um `/compact` que o próprio plugin responde (`session.compact`): ele
devolve a conversa com os turnos marcados trocados pela linha `[removido: …]`,
sem chamar o modelo. As mensagens que ficam inteiras continuam no cache.

| Parte | Hook |
|---|---|
| Status e tamanho do contexto | `session.start`, `session.attach`, `session.measure`, `turn.complete`, `prompt.submit` |
| Registro dos prints e do prompt de cada um | `session.append` |
| Peso medido de cada turno | `turn.complete` (diferença do contexto entre o fim de um turno e o do anterior) |
| Painel e idioma | `command.run` (`/prune`, `/prune en\|pt`) e `ui.render` (`Pane`) |
| Marcas do Claude | `$.tool.register` e `tool.call` (`mcp__context-prune__prune_marks`) |
| Poda | `session.compact`; a automática começa no `prompt.submit` |

Os dados de cada conversa (hora da última resposta, marcas, prints, pesos
medidos) ficam em `~/.claude/plugins/data/context-prune/sessions.json`, fora
da pasta do plugin. Conversas paradas há mais de 30 dias saem do arquivo. O
idioma fica em `preferences.json`, na mesma pasta. Veja
[PRIVACY.md](PRIVACY.md) (em inglês).

## Limitações conhecidas

- O estado do cache é calculado com o TTL de 1 h. Em uso excedente da conta o
  cache cai para 5 min, e o plugin não tem como saber.
- Os turnos são ligados aos pesos e aos prints pelo começo do prompt. Prompts
  que começam iguais, como dois "ok", podem trocar de número entre si.
- Turnos de antes da contagem real ficam estimados (`~`). A estimativa usa a
  conversa no formato que vai para a API, com o raciocínio. O primeiro turno
  depois de uma poda também fica estimado.
- O peso de uma imagem é lido do cabeçalho do PNG. Outros formatos contam o
  máximo, 1,6k. Se a estimativa das imagens de um turno passa do peso medido
  dele, o turno fica estimado (`~`).
- Em contas de organização que gerenciam o Claude Code (planos Team e
  Enterprise com configurações gerenciadas), o Claude Code não passa o
  `session.compact` a plugins que a pessoa instala por conta própria. Ali o
  status, o painel e as marcas funcionam, mas a poda vira um `/compact`
  comum, com resumo feito pelo modelo, a menos que a organização liste o
  plugin nas configurações gerenciadas.
- Se você abrir uma conversa fria e mandar um print ou anexo nos primeiros
  segundos, antes de a poda rodar, a mensagem segue sem podar. A poda espera
  a conversa esfriar de novo.
- Depois de editar o plugin, a mudança vale da segunda mensagem em diante. Às
  vezes o desktop só a carrega depois de reiniciar o Claude.
- O "economizou N tokens" que o app mostra depois de uma poda sai maior que o
  real: o app compara o contexto inteiro de antes só com as mensagens que
  sobraram, sem o prompt do sistema e as ferramentas. O plugin não tem como
  corrigir esse número; o tamanho real aparece na próxima resposta.

## Desenvolvimento

- `hooks/register.tsx`: os hooks e o painel.
- `hooks/lib.ts`: a lógica pura (turnos, marcas, poda, prints, pesos),
  testada em `hooks/lib.test.ts`.
- `hooks/i18n.ts`: os textos de cada idioma.
- `types/index.d.ts`: o contrato do `$.state`.

Para testar sem instalar, carregue a pasta numa sessão:

```bash
claude --plugin-dir .
```

No app desktop, que não aceita a opção, ponha a pasta no
`CLAUDE_CODE_PLUGIN_DIRS`, no bloco `env` de `~/.claude/settings.json`. Não
deixe a versão instalada ligada ao mesmo tempo: as duas cópias duplicam os
hooks.

Para validar e rodar os testes:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

Os testes cobrem a lógica, não o desenho do painel: um erro no painel aparece
como "Nothing to show yet".

## Licença

[MIT](LICENSE)
