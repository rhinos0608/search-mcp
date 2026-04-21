const { spawn } = require('child_process');
const path = require('path');

const MCP_SERVER_PATH =
  process.env.SEARCH_MCP_PATH ||
  path.join(__dirname, '..', '..', 'dist', 'index.js');
const MCP_SERVER_CWD =
  process.env.SEARCH_MCP_CWD || path.join(__dirname, '..', '..');

class McpStdioClient {
  constructor() {
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.initialized = false;
    this.buffer = '';
  }

  async start() {
    if (this.process) {
      if (this.initialized) return;
      await this._waitForInit();
      return;
    }

    this.process = spawn('node', [MCP_SERVER_PATH], {
      cwd: MCP_SERVER_CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.process.stdout.on('data', (data) => this._handleData(data));
    this.process.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) console.error(`[search-mcp] ${text}`);
    });

    this.process.on('error', (err) => {
      console.error(`[search-mcp] Failed to start: ${err.message}`);
      this.process = null;
      this._rejectAllPending(err);
    });

    this.process.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[search-mcp] Exited with code ${code}`);
      }
      this.process = null;
      this.initialized = false;
      this._rejectAllPending(new Error('MCP server process exited'));
    });

    try {
      await this._request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'anythingllm-search-skill', version: '1.0.0' },
      });
      this._notify('notifications/initialized', {});
      this.initialized = true;
    } catch (err) {
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
      throw err;
    }
  }

  _waitForInit() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        if (this.initialized) return resolve();
        if (!this.process) return reject(new Error('MCP server failed'));
        if (Date.now() > deadline)
          return reject(new Error('MCP server init timeout'));
        setTimeout(check, 50);
      };
      check();
    });
  }

  _handleData(data) {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(
              new Error(msg.error.message || JSON.stringify(msg.error)),
            );
          } else {
            resolve(msg.result);
          }
        }
      } catch (e) {
        console.error('[search-mcp] Parse error:', line);
      }
    }
  }

  _request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.process.stdin.write(msg + '\n');

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timed out: ${method}`));
        }
      }, 30000);
    });
  }

  _notify(method, params) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.process.stdin.write(msg + '\n');
  }

  _rejectAllPending(err) {
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }

  async callTool(name, args) {
    try {
      await this.start();
      const result = await this._request('tools/call', {
        name,
        arguments: args,
      });
      if (
        result.content &&
        result.content[0] &&
        result.content[0].text
      ) {
        return result.content[0].text;
      }
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        error: err.message || String(err),
      });
    }
  }
}

const client = new McpStdioClient();

function cleanArgs(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) {
      result[key] = value;
    }
  }
  return result;
}

async function web_search({ query, limit, safeSearch }) {
  return client.callTool('web_search', cleanArgs({ query, limit, safeSearch }));
}

async function web_read({ url }) {
  return client.callTool('web_read', cleanArgs({ url }));
}

async function github_repo({ owner, repo, includeReadme }) {
  return client.callTool(
    'github_repo',
    cleanArgs({ owner, repo, includeReadme }),
  );
}

async function github_trending({ language, since, limit }) {
  return client.callTool(
    'github_trending',
    cleanArgs({ language, since, limit }),
  );
}

async function youtube_transcript({ videoId, language }) {
  return client.callTool(
    'youtube_transcript',
    cleanArgs({ videoId, language }),
  );
}

async function reddit_search({ query, subreddit, sort, timeframe, limit }) {
  return client.callTool(
    'reddit_search',
    cleanArgs({ query, subreddit, sort, timeframe, limit }),
  );
}

async function reddit_comments({
  url,
  permalink,
  subreddit,
  article,
  comment,
  context,
  sort,
  depth,
  limit,
  showMore,
}) {
  return client.callTool(
    'reddit_comments',
    cleanArgs({
      url,
      permalink,
      subreddit,
      article,
      comment,
      context,
      sort,
      depth,
      limit,
      showMore,
    }),
  );
}

async function twitter_search({ query, limit }) {
  return client.callTool('twitter_search', cleanArgs({ query, limit }));
}

async function producthunt_search({ query, sort, limit }) {
  return client.callTool(
    'producthunt_search',
    cleanArgs({ query, sort, limit }),
  );
}

async function patent_search({ query, assignee, limit }) {
  return client.callTool(
    'patent_search',
    cleanArgs({ query, assignee, limit }),
  );
}

async function podcast_search({ query, sort, limit }) {
  return client.callTool(
    'podcast_search',
    cleanArgs({ query, sort, limit }),
  );
}

async function academic_search({ query, source, limit, yearFrom }) {
  return client.callTool(
    'academic_search',
    cleanArgs({ query, source, limit, yearFrom }),
  );
}

async function hackernews_search({
  query,
  type,
  sort,
  dateFrom,
  dateTo,
  limit,
}) {
  return client.callTool(
    'hackernews_search',
    cleanArgs({ query, type, sort, dateFrom, dateTo, limit }),
  );
}

async function youtube_search({ query, order, limit }) {
  return client.callTool(
    'youtube_search',
    cleanArgs({ query, order, limit }),
  );
}

async function arxiv_search({
  query,
  category,
  sortBy,
  dateFrom,
  dateTo,
  limit,
}) {
  return client.callTool(
    'arxiv_search',
    cleanArgs({ query, category, sortBy, dateFrom, dateTo, limit }),
  );
}

async function stackoverflow_search({ query, sort, tagged, accepted, limit }) {
  return client.callTool(
    'stackoverflow_search',
    cleanArgs({ query, sort, tagged, accepted, limit }),
  );
}

async function npm_search({ query, limit }) {
  return client.callTool('npm_search', cleanArgs({ query, limit }));
}

async function pypi_search({ query, limit }) {
  return client.callTool('pypi_search', cleanArgs({ query, limit }));
}

async function news_search({ query, dateFrom, dateTo, language, limit }) {
  return client.callTool(
    'news_search',
    cleanArgs({ query, dateFrom, dateTo, language, limit }),
  );
}

async function health_check() {
  return client.callTool('health_check', {});
}

module.exports = {
  web_search,
  web_read,
  github_repo,
  github_trending,
  youtube_transcript,
  reddit_search,
  reddit_comments,
  twitter_search,
  producthunt_search,
  patent_search,
  podcast_search,
  academic_search,
  hackernews_search,
  youtube_search,
  arxiv_search,
  stackoverflow_search,
  npm_search,
  pypi_search,
  news_search,
  health_check,
};
