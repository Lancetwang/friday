# friday-agent-core

The small TypeScript model/tool loop used by Friday. It has no UI, session,
storage, permission, or product dependencies.

```bash
npm install friday-agent-core
```

```ts
import { Agent, OpenAIModel } from 'friday-agent-core'

const agent = new Agent({
  model: new OpenAIModel({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-5'
  }),
  instructions: 'Be concise.'
})

console.log(await agent.chat('Hello'))
```

See the [Friday repository](https://github.com/Lancetwang/friday) for tools,
the Harness, tests, and architecture notes.
