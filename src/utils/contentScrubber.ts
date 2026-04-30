export type ThreatType =
  | 'prompt_injection'
  | 'instruction_override'
  | 'data_exfiltration'
  | 'impersonation'
  | 'payload_smuggling'
  | 'xss_injection';

export interface ThreatDetection {
  type: ThreatType;
  confidence: number;
  evidence: string;
}

export interface ScrubResult {
  clean: boolean;
  content: string;
  threats: ThreatDetection[];
  riskScore: number;
  redactions: number;
}

interface Pattern {
  type: ThreatType;
  confidence: number;
  regex: RegExp;
  description: string;
}

const PATTERNS: Pattern[] = [
  // ── Prompt injection ────────────────────────────────────────────────
  // Instruction override / role manipulation
  {
    type: 'prompt_injection',
    confidence: 0.9,
    regex: /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/gim,
    description: 'Ignore previous instructions',
  },
  {
    type: 'prompt_injection',
    confidence: 0.9,
    regex: /you\s+are\s+(?:now|actually|really)\s+(?:a|an)\s+(?:different|new)/gim,
    description: 'You are now a different...',
  },
  {
    type: 'prompt_injection',
    confidence: 0.85,
    regex: /\b(?:from\s+now\s+on|starting\s+now)\s*,?\s*(?:you\s+)?(?:are|will\s+be|must)/gim,
    description: 'From now on you are...',
  },
  {
    type: 'instruction_override',
    confidence: 0.9,
    regex: /(?:system\s*(?:message|prompt|instruction)):?\s*/gi,
    description: 'System prompt override',
  },
  {
    type: 'instruction_override',
    confidence: 0.85,
    regex: /\[INST\]|<\|im_start\|>/gi,
    description: 'Chat template injection tokens',
  },
  {
    type: 'instruction_override',
    confidence: 0.8,
    regex: /<\|endoftext\|>/gi,
    description: 'End-of-text token injection',
  },
  // Jailbreak patterns
  {
    type: 'prompt_injection',
    confidence: 0.75,
    regex: /\bdo\s+anything\s+now\b/gi,
    description: 'DAN jailbreak',
  },
  {
    type: 'prompt_injection',
    confidence: 0.7,
    regex: /\bact\s+as\s+a\s+developer\s+mode\b/gi,
    description: 'Developer mode jailbreak',
  },

  // ── Data exfiltration ───────────────────────────────────────────────
  {
    type: 'data_exfiltration',
    confidence: 0.95,
    regex:
      /\b(?:export|send|copy|log|print|echo|display|show)\s+(?:the|your|all)\s+(?:API|secret|credential|token|password|key)\b/gim,
    description: 'Export credentials/tokens',
  },
  {
    type: 'data_exfiltration',
    confidence: 0.85,
    regex: /(?:echo|curl|wget|fetch)\s+.*(?:API_KEY|SECRET|TOKEN|PASSWORD)/g,
    description: 'Shell command exfiltration',
  },
  {
    type: 'data_exfiltration',
    confidence: 0.8,
    regex: /\$\{?(?:process\.env|ENV|env)\[?['"][A-Z_]{3,}/g,
    description: 'Env var access pattern',
  },
  {
    type: 'data_exfiltration',
    confidence: 0.75,
    regex: /document\.cookie|localStorage\.getItem|sessionStorage\.getItem/g,
    description: 'Client-side storage access',
  },

  // ── Impersonation ───────────────────────────────────────────────────
  {
    type: 'impersonation',
    confidence: 0.85,
    regex:
      /\b(?:as\s+(?:a|an)\s+|i\s+am\s+)(?:admin|administrator|moderator|system|superuser|root)\b/gim,
    description: 'Authority impersonation',
  },
  {
    type: 'impersonation',
    confidence: 0.8,
    regex: /\bthis\s+message\s+is\s+from\s+(?:the\s+)?(?:admin|system|moderator|security)\b/gim,
    description: 'System message impersonation',
  },

  // ── Payload smuggling ───────────────────────────────────────────────
  {
    type: 'payload_smuggling',
    confidence: 0.85,
    regex: /(?:base64)?decode|atob|Buffer\.from\s*\(|eval\s*\(['"]/gi,
    description: 'Encoded payload execution',
  },

  // ── XSS injection ───────────────────────────────────────────────────
  {
    type: 'xss_injection',
    confidence: 0.9,
    regex: /<script\b[^>]*>|javascript\s*:\s*(?:void|eval|alert)/gi,
    description: 'Script tag or javascript: URI',
  },
  {
    type: 'xss_injection',
    confidence: 0.85,
    regex: /on(?:error|load|click|mouseover)\s*=\s*['"][^'"]{0,1000}/gi,
    description: 'Inline event handler',
  },
];

export function scrubContent(rawContent: string): ScrubResult {
  if (rawContent.length === 0) {
    return { clean: true, content: '', threats: [], riskScore: 0, redactions: 0 };
  }

  const threats: ThreatDetection[] = [];
  let content = rawContent;

  for (const pattern of PATTERNS) {
    // Collect matches before modifying the string
    const matches = Array.from(content.matchAll(pattern.regex));
    for (const match of matches) {
      const evidence = match[0];
      threats.push({
        type: pattern.type,
        confidence: pattern.confidence,
        evidence,
      });
      content = content.replace(match[0], '[REDACTED]');
    }
  }

  if (threats.length === 0) {
    return { clean: true, content, threats: [], riskScore: 0, redactions: 0 };
  }

  const totalConfidence = threats.reduce((sum, t) => sum + t.confidence, 0) / threats.length;

  // Risk score: weighted by threat count and average confidence
  const threatWeight = Math.min(threats.length / 5, 1);
  const riskScore = Math.min(totalConfidence * threatWeight, 1);

  return {
    clean: false,
    content,
    threats,
    riskScore: Math.round(riskScore * 100) / 100,
    redactions: threats.length,
  };
}
