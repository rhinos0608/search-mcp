# Sample Markdown Fixture

This document contains code examples that should remain atomic.

```ts
import { formatName } from './sample.ts';

export function renderLabel(name: string): string {
  return formatName('doc', name);
}
```

Some text between code blocks.

```python
from sample import format_name

print(format_name('Example'))
```

More narrative text after the code examples.
