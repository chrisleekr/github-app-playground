/**
 * Content sanitization utilities.
 * Ported from claude-code-action's src/github/utils/sanitizer.ts
 *
 * Prevents prompt injection and token leakage by stripping:
 * - Invisible Unicode characters
 * - Hidden HTML attributes
 * - GitHub tokens
 * - Markdown alt-text injection vectors
 */

/** Strip zero-width and control characters */
export function stripInvisibleCharacters(content: string): string {
  // eslint-disable-next-line no-misleading-character-class -- Intentional: stripping individual zero-width chars
  content = content.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  // Intentionally stripping control characters for sanitization
  // eslint-disable-next-line no-control-regex
  const controlCharRegex = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
  content = content.replace(controlCharRegex, "");
  content = content.replace(/\u00AD/g, "");
  content = content.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  return content;
}

/** Strip image alt text (injection vector) */
export function stripMarkdownImageAltText(content: string): string {
  return content.replace(/!\[[^\]]*\]\(/g, "![](");
}

/** Strip markdown link title attributes */
export function stripMarkdownLinkTitles(content: string): string {
  content = content.replace(/(\[[^\]]*\]\([^)]+)\s+"[^"]*"/g, "$1");
  content = content.replace(/(\[[^\]]*\]\([^)]+)\s+'[^']*'/g, "$1");
  return content;
}

/** Strip hidden HTML attributes that could carry injected content */
export function stripHiddenAttributes(content: string): string {
  content = content.replace(/\salt\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\salt\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\stitle\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\stitle\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\saria-label\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\saria-label\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\sdata-[a-zA-Z0-9-]+\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\sdata-[a-zA-Z0-9-]+\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\splaceholder\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\splaceholder\s*=\s*[^\s>]+/gi, "");
  return content;
}

/** Normalize HTML entities to printable ASCII */
export function normalizeHtmlEntities(content: string): string {
  content = content.replace(/&#(\d+);/g, (_match, dec: string) => {
    const num = parseInt(dec, 10);
    if (num >= 32 && num <= 126) {
      return String.fromCharCode(num);
    }
    return "";
  });
  content = content.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
    const num = parseInt(hex, 16);
    if (num >= 32 && num <= 126) {
      return String.fromCharCode(num);
    }
    return "";
  });
  return content;
}

/** Strip HTML comments */
export function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

/** Redact GitHub tokens to prevent leakage */
export function redactGitHubTokens(content: string): string {
  // GitHub Personal Access Tokens (classic)
  content = content.replace(/\bghp_[A-Za-z0-9]{36}\b/g, "[REDACTED_GITHUB_TOKEN]");
  // GitHub OAuth tokens
  content = content.replace(/\bgho_[A-Za-z0-9]{36}\b/g, "[REDACTED_GITHUB_TOKEN]");
  // GitHub installation tokens
  content = content.replace(/\bghs_[A-Za-z0-9]{36}\b/g, "[REDACTED_GITHUB_TOKEN]");
  // GitHub refresh tokens
  content = content.replace(/\bghr_[A-Za-z0-9]{36}\b/g, "[REDACTED_GITHUB_TOKEN]");
  // GitHub fine-grained personal access tokens
  content = content.replace(/\bgithub_pat_[A-Za-z0-9_]{11,221}\b/g, "[REDACTED_GITHUB_TOKEN]");
  return content;
}

/**
 * Full sanitization pipeline.
 * Apply to all user-provided content before including in prompts.
 */
export function sanitizeContent(content: string): string {
  content = stripHtmlComments(content);
  content = stripInvisibleCharacters(content);
  content = stripMarkdownImageAltText(content);
  content = stripMarkdownLinkTitles(content);
  content = stripHiddenAttributes(content);
  content = normalizeHtmlEntities(content);
  content = redactGitHubTokens(content);
  return content;
}
