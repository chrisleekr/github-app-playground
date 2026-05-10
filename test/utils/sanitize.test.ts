import { describe, expect, it } from "bun:test";

import {
  normalizeHtmlEntities,
  redactGitHubTokens,
  redactSecrets,
  sanitizeContent,
  stripHiddenAttributes,
  stripHtmlComments,
  stripInvisibleCharacters,
  stripMarkdownImageAltText,
  stripMarkdownLinkTitles,
} from "../../src/utils/sanitize";

describe("stripInvisibleCharacters", () => {
  it("removes zero-width characters", () => {
    expect(stripInvisibleCharacters("hello\u200Bworld")).toBe("helloworld");
    expect(stripInvisibleCharacters("a\u200Cb\u200Dc\uFEFFd")).toBe("abcd");
  });

  it("removes control characters", () => {
    expect(stripInvisibleCharacters("hello\u0000world")).toBe("helloworld");
    expect(stripInvisibleCharacters("test\u001Fvalue")).toBe("testvalue");
  });

  it("removes soft hyphen", () => {
    expect(stripInvisibleCharacters("soft\u00ADhyphen")).toBe("softhyphen");
  });

  it("removes bidi override characters", () => {
    expect(stripInvisibleCharacters("abc\u202Adef\u202Eghi")).toBe("abcdefghi");
  });

  it("preserves normal text", () => {
    expect(stripInvisibleCharacters("normal text 123")).toBe("normal text 123");
  });
});

describe("stripMarkdownImageAltText", () => {
  it("strips alt text from markdown images", () => {
    expect(stripMarkdownImageAltText("![malicious payload](http://img.png)")).toBe(
      "![](http://img.png)",
    );
  });

  it("preserves images without alt text", () => {
    expect(stripMarkdownImageAltText("![](http://img.png)")).toBe("![](http://img.png)");
  });

  it("handles multiple images", () => {
    expect(stripMarkdownImageAltText("![a](1.png) text ![b](2.png)")).toBe(
      "![](1.png) text ![](2.png)",
    );
  });
});

describe("stripMarkdownLinkTitles", () => {
  it("strips double-quoted title attributes", () => {
    expect(stripMarkdownLinkTitles('[link](http://url "title")')).toBe("[link](http://url)");
  });

  it("strips single-quoted title attributes", () => {
    expect(stripMarkdownLinkTitles("[link](http://url 'title')")).toBe("[link](http://url)");
  });

  it("preserves links without titles", () => {
    expect(stripMarkdownLinkTitles("[link](http://url)")).toBe("[link](http://url)");
  });
});

describe("stripHiddenAttributes", () => {
  it("strips alt attributes", () => {
    expect(stripHiddenAttributes('<img alt="payload" src="x">')).toBe('<img src="x">');
  });

  it("strips title attributes", () => {
    expect(stripHiddenAttributes('<a title="payload">text</a>')).toBe("<a>text</a>");
  });

  it("strips aria-label attributes", () => {
    expect(stripHiddenAttributes('<div aria-label="payload">text</div>')).toBe("<div>text</div>");
  });

  it("strips data-* attributes", () => {
    expect(stripHiddenAttributes('<div data-inject="payload">text</div>')).toBe("<div>text</div>");
  });

  it("strips placeholder attributes", () => {
    expect(stripHiddenAttributes('<input placeholder="payload">')).toBe("<input>");
  });
});

describe("normalizeHtmlEntities", () => {
  it("converts decimal entities in printable range", () => {
    expect(normalizeHtmlEntities("&#65;")).toBe("A");
    expect(normalizeHtmlEntities("&#97;")).toBe("a");
  });

  it("converts hex entities in printable range", () => {
    expect(normalizeHtmlEntities("&#x41;")).toBe("A");
  });

  it("removes entities outside printable range", () => {
    expect(normalizeHtmlEntities("&#0;")).toBe("");
    expect(normalizeHtmlEntities("&#200;")).toBe("");
  });
});

describe("stripHtmlComments", () => {
  it("removes HTML comments", () => {
    expect(stripHtmlComments("before<!-- hidden -->after")).toBe("beforeafter");
  });

  it("removes multi-line comments", () => {
    expect(stripHtmlComments("a<!--\ninjection\npayload\n-->b")).toBe("ab");
  });
});

describe("redactGitHubTokens", () => {
  it("redacts personal access tokens (classic)", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(redactGitHubTokens(`token: ${token}`)).toBe("token: [REDACTED_GITHUB_TOKEN]");
  });

  it("redacts OAuth tokens", () => {
    const token = `gho_${"a".repeat(36)}`;
    expect(redactGitHubTokens(token)).toBe("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts installation tokens", () => {
    const token = `ghs_${"a".repeat(36)}`;
    expect(redactGitHubTokens(token)).toBe("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts refresh tokens", () => {
    const token = `ghr_${"a".repeat(36)}`;
    expect(redactGitHubTokens(token)).toBe("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts fine-grained PATs", () => {
    const token = `github_pat_${"a".repeat(40)}`;
    expect(redactGitHubTokens(token)).toBe("[REDACTED_GITHUB_TOKEN]");
  });

  it("preserves non-token text", () => {
    expect(redactGitHubTokens("normal text")).toBe("normal text");
  });
});

describe("sanitizeContent (full pipeline)", () => {
  it("applies all sanitization steps", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const input = `<!-- hidden -->\u200BHello ![injection](img.png) ${token}`;
    const result = sanitizeContent(input);

    expect(result).not.toContain("hidden");
    expect(result).not.toContain("\u200B");
    expect(result).not.toContain("injection");
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(result).toContain("Hello");
  });

  it("handles empty string", () => {
    expect(sanitizeContent("")).toBe("");
  });

  it("passes through clean content unchanged", () => {
    expect(sanitizeContent("clean text")).toBe("clean text");
  });
});

describe("redactSecrets (output-side silent strip)", () => {
  it("returns body unchanged with empty kinds when no secrets present", () => {
    const r = redactSecrets("totally normal markdown comment");
    expect(r.body).toBe("totally normal markdown comment");
    expect(r.matchCount).toBe(0);
    expect(r.kinds).toEqual([]);
  });

  it("silently strips a GitHub PAT (no marker)", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const r = redactSecrets(`prefix ${token} suffix`);
    expect(r.body).toBe("prefix  suffix");
    expect(r.body).not.toContain("REDACTED");
    expect(r.body).not.toContain(token);
    expect(r.matchCount).toBe(1);
    expect(r.kinds).toEqual(["GITHUB_TOKEN"]);
  });

  it("strips Anthropic API keys", () => {
    const key = `sk-ant-api03-${"x".repeat(80)}`;
    const r = redactSecrets(key);
    expect(r.body).toBe("");
    expect(r.matchCount).toBe(1);
    expect(r.kinds).toContain("ANTHROPIC_API_KEY");
  });

  it("strips Anthropic OAuth tokens", () => {
    const token = `sk-ant-oat01-${"y".repeat(80)}`;
    const r = redactSecrets(token);
    expect(r.body).toBe("");
    expect(r.matchCount).toBe(1);
    expect(r.kinds).toContain("ANTHROPIC_OAUTH");
  });

  it("strips AWS access key IDs (long-lived + STS)", () => {
    const akia = `AKIA${"A".repeat(16)}`;
    const asia = `ASIA${"B".repeat(16)}`;
    const r = redactSecrets(`access=${akia} session=${asia}`);
    expect(r.body).toBe("access= session=");
    expect(r.matchCount).toBe(2);
    expect(r.kinds).toEqual(["AWS_ACCESS_KEY_ID"]);
  });

  it("strips PEM-encoded private keys including multiline", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIICXgIBAAKBgQDABCDEFGHIJ
-----END RSA PRIVATE KEY-----`;
    const r = redactSecrets(`leak: ${pem}\ntrailer`);
    expect(r.body).toBe("leak: \ntrailer");
    expect(r.matchCount).toBe(1);
    expect(r.kinds).toContain("PRIVATE_KEY_PEM");
  });

  it("strips DB URLs with embedded passwords (postgres/redis/mongodb/mysql)", () => {
    const inputs = [
      "postgres://alice:s3cret@db.local:5432/app",
      "redis://default:p4ss@cache.local:6379",
      "mongodb+srv://u:hunter2@cluster.example.net",
      "mysql://root:rootpw@db:3306/x",
    ];
    for (const url of inputs) {
      const r = redactSecrets(`conn=${url} done`);
      expect(r.body).toBe("conn= done");
      expect(r.kinds).toContain("DB_URL_WITH_PASSWORD");
      expect(r.matchCount).toBeGreaterThan(0);
    }
  });

  it("strips JWTs", () => {
    const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
    const r = redactSecrets(`bearer: ${jwt}`);
    expect(r.body).toBe("bearer: ");
    expect(r.matchCount).toBe(1);
    expect(r.kinds).toContain("JWT");
  });

  it("counts every match across multiple kinds and dedupes kinds", () => {
    const ghp = `ghp_${"a".repeat(36)}`;
    const akia = `AKIA${"Z".repeat(16)}`;
    const r = redactSecrets(`${ghp} and ${ghp} and ${akia}`);
    expect(r.matchCount).toBe(3);
    expect(r.kinds.sort()).toEqual(["AWS_ACCESS_KEY_ID", "GITHUB_TOKEN"]);
  });

  it("never logs the matched bytes: body never contains the original secret substring", () => {
    const token = `ghp_${"x".repeat(36)}`;
    const r = redactSecrets(token);
    expect(r.body).toBe("");
    expect(JSON.stringify(r)).not.toContain(token);
  });
});
