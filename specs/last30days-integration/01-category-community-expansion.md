# Spec: Category→Community Expansion for queryExpansion.ts

## Source Pattern

From `last30days/scripts/lib/categories.py`: Maps product categories to peer community subreddits via compound-term pattern matching.

## Goal

Add a category→community expansion layer to `queryExpansion.ts` that detects when a query is about a product/tool in a known category and appends category-peer community names to expand the search surface.

## Target File

`src/tools/queryExpansion.ts`

## Design

### New Export

```typescript
export interface CategoryExpansion {
  categoryId: string;
  peerCommunities: string[];
}

export function detectCategory(query: string): CategoryExpansion | null;
```

### Category Table

Port the 11 categories from `categories.py` as a `CATEGORY_PEERS` map:

```typescript
const CATEGORY_PEERS: Record<string, { patterns: string[]; peers: string[] }> = {
  ai_image_generation: {
    patterns: [
      'image generation',
      'image gen',
      'text to image',
      'text-to-image',
      'gpt image',
      'gpt-image',
      'midjourney',
      'stable diffusion',
      'stablediffusion',
      'dall-e',
      'dalle',
      'flux.1',
      'flux schnell',
      'imagen',
      'seedance',
      'ideogram',
      'recraft',
    ],
    peers: ['StableDiffusion', 'midjourney', 'dalle2', 'aiArt', 'PromptEngineering'],
  },
  ai_video_generation: {
    patterns: [
      'video generation',
      'text to video',
      'text-to-video',
      'sora',
      'veo 3',
      'veo3',
      'runway gen',
      'kling',
      'pika labs',
      'luma dream machine',
      'hailuo',
    ],
    peers: ['aivideo', 'StableDiffusion', 'runwayml', 'singularity'],
  },
  ai_music_generation: {
    patterns: ['music generation', 'ai music', 'suno', 'udio', 'riffusion', 'stable audio'],
    peers: ['SunoAI', 'udiomusic', 'aimusic', 'artificial'],
  },
  ai_coding_agent: {
    patterns: [
      'claude code',
      'cursor ide',
      'github copilot',
      'windsurf',
      'aider',
      'cline',
      'openclaw',
      'hermes agent',
      'continue.dev',
      'codeium',
      'sweep ai',
      'devin ai',
      'coding agent',
      'coding assistant',
    ],
    peers: ['ChatGPTCoding', 'LocalLLaMA', 'singularity', 'PromptEngineering'],
  },
  ai_agent_framework: {
    patterns: [
      'agent framework',
      'agentic framework',
      'langchain',
      'langgraph',
      'crewai',
      'autogen',
      'llamaindex',
      'dspy',
      'smolagents',
    ],
    peers: ['LangChain', 'LocalLLaMA', 'AI_Agents', 'MachineLearning'],
  },
  ai_chat_model: {
    patterns: [
      'gpt-5',
      'gpt-4',
      'claude opus',
      'claude sonnet',
      'claude haiku',
      'gemini pro',
      'gemini flash',
      'llama 3',
      'llama 4',
      'deepseek',
      'qwen',
      'mistral large',
      'grok',
    ],
    peers: ['LocalLLaMA', 'ChatGPT', 'ClaudeAI', 'singularity', 'artificial'],
  },
  saas_screen_recording: {
    patterns: [
      'screen recording',
      'screen recorder',
      'loom video',
      'tella screen',
      'vidyard',
      'screen capture tool',
    ],
    peers: ['SaaS', 'screenrecording', 'productivity', 'Entrepreneur'],
  },
  saas_productivity: {
    patterns: [
      'notion app',
      'obsidian plugin',
      'obsidian app',
      'linear app',
      'asana',
      'clickup',
      'productivity app',
    ],
    peers: ['productivity', 'SaaS', 'ObsidianMD', 'Notion'],
  },
  prediction_markets: {
    patterns: ['polymarket', 'kalshi', 'prediction market', 'event contracts', 'manifold markets'],
    peers: ['Polymarket', 'Kalshi', 'predictionmarkets'],
  },
  crypto_defi: {
    patterns: [
      'defi protocol',
      'yield farming',
      'liquidity pool',
      'stablecoin',
      'ethereum layer',
      'layer 2',
      'l2 rollup',
    ],
    peers: ['defi', 'ethfinance', 'CryptoCurrency', 'ethereum'],
  },
  dev_tool_cli: {
    patterns: ['cli tool', 'command line tool', 'terminal app', 'dev tool'],
    peers: ['commandline', 'programming', 'webdev'],
  },
};
```

### Matching Logic

- Case-insensitive word-boundary regex match (prevents false positives like 'mydalle' matching 'dalle')
- First-match-wins (declaration order from most-specific to least-specific)
- Same pattern as `categories.py`: `detect_category()`

### Integration with expandQuery

Add a new strategy `'category'` to `QueryVariation`:

```typescript
// In expandQuery():
const category = detectCategory(original);
if (category !== null) {
  variations.push({
    query: `${original} ${category.peerCommunities.slice(0, 3).join(' ')}`,
    strategy: 'category',
  });
}
```

## Verification

1. `expandQuery('GPT Image 2 prompting')` should produce a `category` variation with peers `StableDiffusion midjourney aiArt`
2. `expandQuery('best headphones')` should produce no category variation (no match)
3. `expandQuery('Claude Code review')` should match `ai_coding_agent`
4. `expandQuery('midjourney prompts')` should match `ai_image_generation` (most-specific wins)
