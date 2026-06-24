import dotenv from "dotenv";
// Load local env files for local development. AI Studio injects secrets at
// runtime, but locally we read them from .env.local (preferred) then .env.
dotenv.config({ path: ".env.local" });
dotenv.config();

import express from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import * as cheerio from "cheerio";
import Anthropic from "@anthropic-ai/sdk";

// --- Audit Learnings Store ---------------------------------------------------
// Confirmed false positives are saved per-hostname as a markdown file and fed
// back into future audit prompts so the model stops repeating the same mistake.
const LEARNINGS_DIR = path.join(process.cwd(), "learnings");

function learningsFileFor(hostname: string): string {
  const safe = (hostname || "unknown").replace(/[^a-z0-9.\-_]/gi, "_");
  return path.join(LEARNINGS_DIR, `${safe}.md`);
}

function readLearnings(hostname: string): string {
  try {
    const f = learningsFileFor(hostname);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf-8").trim();
  } catch {
    // ignore read errors — learnings are best-effort context
  }
  return "";
}

// Structured sidecar (alongside the human-readable .md) used to HARD-filter
// confirmed false positives out of results, regardless of model compliance.
interface LearningEntry { category: string; identifier: string; }

function learningsJsonFor(hostname: string): string {
  return learningsFileFor(hostname).replace(/\.md$/, ".json");
}

function readLearningEntries(hostname: string): LearningEntry[] {
  try {
    const f = learningsJsonFor(hostname);
    if (fs.existsSync(f)) {
      const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore — best-effort
  }
  return [];
}

// Build the identifier for a finding. MUST mirror the frontend's id builders so
// dismissed findings match on the next scan.
function issueIdentifier(category: string, item: any): string {
  switch (category) {
    case "content": return String(item?.excerpt ?? "");
    case "heading": return `${item?.tag ?? ""}: ${item?.headingText ?? ""}`;
    case "link": return `${item?.anchorText ?? ""} -> ${item?.url ?? ""}`;
    case "semantic": return String(item?.elementContent ?? "");
    default: return "";
  }
}

function hostnameFromUrl(raw: string): string {
  try {
    const v = raw.startsWith("http") ? raw : "https://" + raw;
    return new URL(v).hostname;
  } catch {
    return "";
  }
}

// Initialize Gemini Client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Lazy initialize Anthropic Client to prevent startup crashes when the key is missing
let anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error("ANTHROPIC_API_KEY is not configured in your Secrets/Environment variables. Please configure the ANTHROPIC_API_KEY secret and try again.");
    }
    anthropicClient = new Anthropic({
      apiKey: key,
    });
  }
  return anthropicClient;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));

  // Discover URLs via Sitemap or Homepage crawl fallbacks
  app.post("/api/discover", async (req, res) => {
    try {
      let { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }

      let validUrl = url.trim();
      if (!validUrl.startsWith("http://") && !validUrl.startsWith("https://")) {
        validUrl = "https://" + validUrl;
      }

      let origin = "";
      let hostname = "";
      try {
        const u = new URL(validUrl);
        origin = u.origin;
        hostname = u.hostname;
      } catch (e) {
        return res.status(400).json({ error: "Invalid URL format" });
      }

      const discoveredUrls = new Set<string>();
      discoveredUrls.add(validUrl); // Always include the requested URL first

      // 1. Try to fetch Sitemap
      const sitemapUrls = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
      let sitemapContent = "";

      for (const sUrl of sitemapUrls) {
        try {
          const sResponse = await fetch(sUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
          });
          if (sResponse.ok) {
            const content = await sResponse.text();
            if (content.includes("<loc>")) {
              sitemapContent = content;
              break;
            }
          }
        } catch (e) {
          // Silent catch to try fallback
        }
      }

      if (sitemapContent) {
        // Parse loc tags with regex
        const locRegex = /<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi;
        let match;
        while ((match = locRegex.exec(sitemapContent)) !== null) {
          try {
            const locUrl = match[1].trim();
            const locObj = new URL(locUrl);
            if (locObj.hostname === hostname) {
              // Exclude obvious static assets
              if (!locUrl.match(/\.(png|jpe?g|gif|svg|pdf|zip|xml|css|js|woff2?|ico)$/i)) {
                discoveredUrls.add(locUrl);
              }
            }
          } catch (e) {
            // Invalid URL in sitemap
          }
        }
      }

      // 2. Fallback: If sitemap didn't yield other URLs, fetch homepage and crawl internal anchor links
      if (discoveredUrls.size <= 1) {
        try {
          const response = await fetch(validUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
          });
          if (response.ok) {
            const html = await response.text();
            const $ = cheerio.load(html);
            $("a").each((_, el) => {
              let href = $(el).attr("href");
              if (!href) return;
              href = href.trim();

              let resolvedUrl = "";
              if (href.startsWith("http://") || href.startsWith("https://")) {
                resolvedUrl = href;
              } else if (href.startsWith("/")) {
                resolvedUrl = origin + href;
              } else if (!href.startsWith("#") && !href.startsWith("mailto:") && !href.startsWith("tel:") && !href.startsWith("javascript:")) {
                // relative page links like about.html or services/page
                resolvedUrl = origin + "/" + href;
              }

              if (resolvedUrl) {
                try {
                  // strip hashes and trailing slashes for deduplication
                  const cleanU = new URL(resolvedUrl);
                  cleanU.hash = "";
                  let finalUrl = cleanU.toString();
                  if (finalUrl.endsWith("/") && finalUrl.length > origin.length + 1) {
                    finalUrl = finalUrl.slice(0, -1);
                  }

                  if (cleanU.hostname === hostname) {
                    if (!finalUrl.match(/\.(png|jpe?g|gif|svg|pdf|zip|xml|css|js|woff2?|ico)$/i)) {
                      discoveredUrls.add(finalUrl);
                    }
                  }
                } catch (e) {
                  // Invalid URL
                }
              }
            });
          }
        } catch (e) {
          // Ignored
        }
      }

      // Convert to array, clean trailing slash for standard representation
      const pagesList = Array.from(discoveredUrls).map(p => {
        // Strip trailing slash if it exists and isn't just the base URL
        if (p.endsWith("/") && p.length > origin.length + 1) {
          return p.slice(0, -1);
        }
        return p;
      });

      // Deduplicate again after potential trailing slash stripping
      const uniquePages = Array.from(new Set(pagesList)).slice(0, 15); // limit to max 15 pages for safety/speed

      res.json({ pages: uniquePages });
    } catch (error: any) {
      console.error("Discovery error:", error);
      res.status(500).json({ error: error.message || "Failed to discover website URLs" });
    }
  });

  // API constraints
  app.post("/api/audit", async (req, res) => {
    try {
      const { url, siteStructure, provider } = req.body;
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }

      // Fetch Website Content
      let htmlResponse;
      try {
        htmlResponse = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
        });
        if (!htmlResponse.ok) {
           throw new Error(`Failed to fetch URL: ${htmlResponse.statusText}`);
        }
      } catch (e: any) {
         return res.status(500).json({ error: `Failed to fetch URL content: ${e.message}` });
      }

      const html = await htmlResponse.text();
      const $ = cheerio.load(html);
      
      // Extract links and their surrounding contexts before purging tags so we have full source metadata
      const rawLinks: { anchorText: string; url: string; context: string }[] = [];
      $("a").each((_, el) => {
          const href = $(el).attr("href");
          const anchorText = $(el).text().replace(/\s+/g, " ").trim();
          if (href && anchorText && (href.startsWith("http://") || href.startsWith("https://"))) {
              // Extract the surrounding line/paragraph parent text to locate the section context
              const context = $(el).parent().text().replace(/\s+/g, " ").trim().substring(0, 200);
              rawLinks.push({
                  anchorText,
                  url: href,
                  context
              });
          }
      });

      // De-duplicate URLs and limit count to prevent prompt bloat while remaining comprehensive
      const seenUrls = new Set<string>();
      const uniqueLinks = rawLinks.filter(item => {
          if (seenUrls.has(item.url)) return false;
          seenUrls.add(item.url);
          return true;
      }).slice(0, 50);

      // Extract heading sequence details before stripping the DOM tags
      const headingsData: { tag: string; text: string; subsequentText: string }[] = [];
      $("h1, h2, h3, h4, h5, h6").each((_, el) => {
          const tag = (el as any).name ? (el as any).name.toUpperCase() : "";
          const text = $(el).text().replace(/\s+/g, " ").trim();
          
          let subsequentText = "";
          let next = $(el).next();
          let siblingsParsed = 0;
          while (next.length && siblingsParsed < 3) {
              const firstElem = next[0] as any;
              const tagType = firstElem && firstElem.name ? firstElem.name.toUpperCase() : "";
              if (["H1", "H2", "H3", "H4", "H5", "H6"].includes(tagType)) {
                  break;
              }
              const nextTxt = next.text().replace(/\s+/g, " ").trim();
              if (nextTxt) {
                  subsequentText += " " + nextTxt;
                  siblingsParsed++;
              }
              next = next.next();
          }
          subsequentText = subsequentText.trim().substring(0, 400);

          if (text) {
              headingsData.push({
                  tag,
                  text,
                  subsequentText
              });
          }
      });

      // Extract suspected contact/semantic snippets with HTML markup (so the AI can analyze if correct tags like <address> or <dl> are used)
      const semanticSnippets: { html: string; text: string }[] = [];
      $("address, dl, p, div, footer, section").each((_, el) => {
          const text = $(el).text().replace(/\s+/g, " ").trim();
          const tag = (el as any).name ? (el as any).name.toLowerCase() : "";
          
          const isAddressCandidate = text.match(/\b\d{3,5}\s+[A-Za-z0-9\.\s]{3,30}\s+(street|st|rd|road|dr|drive|ave|avenue|ln|lane|suite|ste|zip|postal|google.com\/maps)\b/i) || tag === "address";
          const isHoursCandidate = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon-fri|closed|hours)\b/i) || tag === "dl";
          
          if (isAddressCandidate || isHoursCandidate) {
              const outerHtml = $.html(el);
              if (outerHtml.length < 2000 && outerHtml.length > 20) {
                  if (!semanticSnippets.some(s => s.text === text)) {
                      semanticSnippets.push({
                          html: outerHtml.substring(0, 1500),
                          text: text.substring(0, 400)
                      });
                  }
              }
          }
      });

      // Extract custom inline/content images and filter out structural ones
      const contentImages: { src: string; alt: string; parentTag: string }[] = [];
      $("img").each((_, el) => {
          const $img = $(el);
          const src = $img.attr("src") || $img.attr("data-src") || "";
          const alt = ($img.attr("alt") || $img.attr("title") || "").trim();
          
          if (!src || src.startsWith("data:image/svg+xml") || src.startsWith("data:image/gif")) {
              return;
          }

          // Exclude structural header/footer layout elements to prevent false positives
          let isStructural = false;
          let parent = $img.parent();
          let depth = 0;
          while (parent.length && depth < 5) {
              const parentTag = (parent[0] as any).name?.toLowerCase() || "";
              const parentId = (parent.attr("id") || "").toLowerCase();
              const parentClass = (parent.attr("class") || "").toLowerCase();
              
              if (["header", "footer", "nav", "aside", "menu"].includes(parentTag)) {
                  isStructural = true;
                  break;
              }
              if (parentTag === "a" && (parentClass.includes("logo") || parentId.includes("logo"))) {
                  isStructural = true;
                  break;
              }
              if (parentId.includes("header") || parentId.includes("footer") || parentId.includes("nav") || parentId.includes("sidebar") || parentId.includes("menu")) {
                  isStructural = true;
                  break;
              }
              if (parentClass.includes("header") || parentClass.includes("footer") || parentClass.includes("nav") || parentClass.includes("sidebar") || parentClass.includes("menu")) {
                  isStructural = true;
                  break;
              }
              parent = parent.parent();
              depth++;
          }

          if (isStructural) return;

          // Exclude image keywords representing logos, site icons, or interface decorations
          const srcLower = src.toLowerCase();
          const altLower = alt.toLowerCase();
          const imgIdLower = ($img.attr("id") || "").toLowerCase();
          const imgClassLower = ($img.attr("class") || "").toLowerCase();

          const ignoredKeywords = ["logo", "icon", "avatar", "social", "badge", "chevron", "arrow", "button", "sprite", "favicon", "widget"];
          const matchesIgnored = ignoredKeywords.some(keyword => 
              srcLower.includes(keyword) || 
              altLower.includes(keyword) || 
              imgIdLower.includes(keyword) || 
              imgClassLower.includes(keyword)
          );

          if (matchesIgnored) return;

          // Resolve relative pathways to fully qualified absolute URL addresses
          let absoluteSrc = src;
          try {
              absoluteSrc = new URL(src, url).href;
          } catch (_) {
              absoluteSrc = src;
          }

          contentImages.push({
              src: absoluteSrc,
              alt: alt || "No alt text provided",
              parentTag: ($img.parent()[0] as any).name?.toLowerCase() || "div"
          });
      });

      // Remove scripts, styles, and other non-content tags (guaranteeing no graphic or secondary assets are fetched/rendered)
      $("script, style, noscript, nav, footer, iframe, img, svg, picture, source, video, audio, link, canvas, map, object, embed").remove();

      // Remove cookie consent, privacy notices, and compliance banners
      $("[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [id*='gdpr' i], [class*='gdpr' i], [class*='privacypolicy' i]").remove();

      let textContent = $("body").text().replace(/\s+/g, " ").trim();

      // Clean up common cookie / privacy consent sentences that might remain as loose text
      textContent = textContent
        .replace(/this website uses cookies.*?agree|we use cookies.*?accept|cookie policy.*?privacy policy|by clicking .*?agree/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      if (!textContent) {
          return res.status(400).json({ error: "Could not extract text from the provided URL" });
      }

      const responseSchema = {
          type: Type.OBJECT,
          properties: {
              mainTopic: {
                  type: Type.STRING,
                  description: "A short summary of the main topic and purpose of the website based on the content."
              },
              misplacedContent: {
                  type: Type.ARRAY,
                  items: {
                      type: Type.OBJECT,
                      properties: {
                          excerpt: {
                              type: Type.STRING,
                              description: "The exact quote or snippet of text that appears misplaced or off-topic."
                          },
                          reason: {
                              type: Type.STRING,
                              description: "Why this content is considered misplaced relative to the main topic."
                          }
                      },
                      required: ["excerpt", "reason"]
                  },
                  description: "A list of excerpts that do not fit the main theme of the website."
              },
              linkIssues: {
                  type: Type.ARRAY,
                  items: {
                      type: Type.OBJECT,
                      properties: {
                          anchorText: {
                              type: Type.STRING,
                              description: "The specific anchor link text / word that contains the issue, or the name of an unlinked service."
                          },
                          url: {
                              type: Type.STRING,
                              description: "The fully qualified target URL, or 'none' if an expected link to a standalone service page is missing."
                          },
                          section: {
                              type: Type.STRING,
                              description: "The surrounding context or section text where this link issue was identified."
                          },
                          reason: {
                              type: Type.STRING,
                              description: "Why this link is problematic, e.g., points to unrelated domains, or if a listed service is unlinked and missing navigation to its standalone page."
                          }
                      },
                      required: ["anchorText", "url", "section", "reason"]
                  },
                  description: "A list of identified redirect, shady, or unlinked service pages and broken pathways."
              },
              headingIssues: {
                  type: Type.ARRAY,
                  items: {
                      type: Type.OBJECT,
                      properties: {
                          headingText: {
                              type: Type.STRING,
                              description: "The exact text of the heading being audited."
                          },
                          tag: {
                              type: Type.STRING,
                              description: "The HTML heading level (e.g., H1, H2, H3, H4, H5, H6)."
                          },
                          issueType: {
                              type: Type.STRING,
                              description: "The category: 'structure_skip', 'multiple_h1', 'capitalization', 'mismatched_content', or 'other'."
                          },
                          context: {
                              type: Type.STRING,
                              description: "The context of the issue, e.g., the structural parent level or the text of the paragraph."
                          },
                          reason: {
                              type: Type.STRING,
                              description: "Detailed description of the issue under specified criteria."
                          }
                       },
                       required: ["headingText", "tag", "issueType", "reason"]
                  },
                  description: "A list of structural, capitalization, or content-match issues detected in the page's headings."
              },
              semanticIssues: {
                  type: Type.ARRAY,
                  items: {
                      type: Type.OBJECT,
                      properties: {
                          elementContent: {
                              type: Type.STRING,
                              description: "The core text excerpt of the non-semantic postal address or business hours block."
                          },
                          issueType: {
                              type: Type.STRING,
                              description: "Either 'address_missing_address_tag' or 'hours_missing_definition_list'."
                          },
                          reason: {
                              type: Type.STRING,
                              description: "Clear explanation that physical addresses must use the <address> tag, or that business hours should use <dl> definition maps."
                          },
                          recommendation: {
                              type: Type.STRING,
                              description: "The specific correct HTML block recommended to fix this issue (e.g., wraps contents in <address> or <dl><dt><dd>)."
                          }
                      },
                      required: ["elementContent", "issueType", "reason", "recommendation"]
                  },
                  description: "A list of non-semantic HTML layout practices detected for addresses or hours metadata."
              }
          },
          required: ["mainTopic", "misplacedContent", "linkIssues", "headingIssues", "semanticIssues"]
      };

      const priorLearnings = readLearnings(hostnameFromUrl(url));

      const auditPrompt = `Analyze the following webpage content, links, headings, semantic HTML fragments, and full site structure to identify inconsistencies, structural/hierarchical problems, capitalization errors, content mismatches, design-structure mistakes, or unlinked service items.

Identify the main topic/purpose of the site.

CRITICAL — Respect prior reviewer feedback: A list of CONFIRMED FALSE POSITIVES from previous manual review is provided at the very bottom under "Known False Positives". You MUST NOT report any issue that matches, or is substantially similar to, an entry in that list. Treat those items as correct.

Every issue object you return MUST include a specific, non-empty "reason" that clearly explains WHY it is a problem. Never return an empty or generic reason.

Then audit and identify issues following these rigorous rules:

1. Text Relevancy:
   Identify any loose text or content block (not under a mismatched heading) that seems misplaced or completely irrelevant compared to the core topic.

2. Outgoing Links:
   Review the list of outgoing links extracted. Point out any 'redirect link' issues - links pointing to unexpected, unrelated, or spam/ad/phishing domains.

3. Heading Structure & Hierarchy Check of H1-H6:
   - There should be ONLY ONE H1 tag on the page. Multiple H1s must be flagged as 'multiple_h1'.
   - The hierarchy MUST NOT skip levels. For example, skipping from H1 -> H3, H1 -> H4, or H2 -> H4 directly is an issue. Flag these as 'structure_skip'.
   - Each secondary section starts with an H2, then nested levels must follow an H2 (e.g., H3 is under H2, H4 is under H3).

4. Heading Capitalization Checking:
   - CRITICAL FALSE POSITIVE PREVENTER: Before flagging ANY capitalization issue, examine the heading text very carefully. You MUST NOT make false accusations. If you claim a word should be lowercase/capitalized, check if it is ALREADY lowercase/capitalized in the provided heading.
   - For example:
     - In "Advanced Technology for Better Experiences", the word 'for' has 3 characters and is lowercase. This is 100% CORRECT. Do NOT flag this!
     - In "Kids to Adults", the word 'to' has 2 characters and is lowercase. This is 100% CORRECT. Do NOT flag this!
     - In "Why choose us?", only the first word 'Why' is capitalized. This is standard Sentence Case. This is 100% CORRECT for a question heading. Do NOT flag this!
   - Capitalization Rules:
     - General Headings: They should follow Title Case OR standard Sentence Case (only the first word capitalized, e.g., "A dentist you can trust"). BOTH of these standard patterns are 100% correct.
     - 1-2 Character Preposition/Conjunction Constraint: For Title Case, ONLY 1-character or 2-character prepositions, conjunctions, or articles (like 'a', 'it', 'to', 'in', 'of', 'on', 'by', 'as', 'at', 'an', 'or', 'if', 'is', 'us') should be lowercase. Prepositions or conjunctions that have 3 or more characters (like 'for', 'the', 'and', 'with', 'under', 'from', 'about', 'doing', 'one') are ALLOWED to be capitalized OR lowercase. Do NOT flag 3+ character words as capitalization faults under any circumstances!
     - Question Headings (headings ending with '?' or asking a question): ONLY the first word should be capitalized (e.g., "Why choose us?"), with the absolute exemption of Proper nouns / Business names which must always start with a capital letter (e.g., "How does Patterson Family Smiles help you?"). If a question heading uses Sentence Case ("Why choose us?") or clean Title Case ("Why Choose Us?"), they are BOTH perfectly acceptable and should NOT be flagged.
     - Business/Brand/Proper Names: Every word in a business/brand name or proper noun must always start with a capital letter (e.g., "Patterson Family Smiles").
     - ONLY flag real, undeniable, incorrect capitalization issues:
        a) Headings that are completely lowercase (e.g., "comprehensive dentistry under one roof", "why choose us?").
        b) Headings with chaotic, broken, random casing (e.g., "CHeck out our SERvices").
        c) Headings where the very first word starts with a lowercase letter (e.g., "about us").
        d) Proper nouns or brand names that are lowercase (e.g., "patterson family smiles").

5. Title vs Content Matching:
   - Analyze whether the heading matches its subsequent text content. Flag as 'mismatched_content' ONLY if the actual content block/paragraphs under a heading have absolutely nothing to do with the heading's title (e.g., an 'Our Team' heading followed immediately by content about bitcoin mining). If they are generally aligned or related, do NOT flag it. Let's be highly accurate and avoid false positives.

6. Semantic HTML Check:
   - Examine the Suspected Address & Business Hours HTML snippets below.
   - Grounded rule 1 (Address): Evaluate if any valid postal contact address is missing its <address> tag counterpart. If an address is formatted inside raw paragraphs <p> or general divs <div> without an enclosing <address> tag wrapper, flag it with issueType 'address_missing_address_tag'.
   - Grounded rule 2 (Business Hours): Evaluate if business open hours are written as raw paragraphs or div tags rather than a semantic definition list map structure (e.g. <dl> with <dt> for days and <dd> for hours). If they are written as raw text blocks, flag it with issueType 'hours_missing_definition_list'. Provide clear recommendations showing correct semantic markup.

7. Services Linking Audit:
   - Identify sections on the audited page named "Services", "Our Services", or other medical/business service sections.
   - Review the Existing Site Structure list of indexed pages below.
   - For every service item listed dynamically in that "Services" section, expect it to actively link to its dedicated service-detail page if such a page exists within the overall site structure (e.g. if 'implants' is listed and a page like '/services/implants' exists in the site structure).
   - If a highlighted service item has NO link (presented as plain static text) or has broken pathways, flag it under 'linkIssues'. Set anchorText to the service name, url to the target standalone path from site structure (or 'none' if unavailable), section to 'Services Section', and explain inside reason that they should link this service module directly to their standalone detail page to improve internal link discovery/juice.

--- Webpage text content ---
${textContent.substring(0, 30000)}

--- Extracted Outgoing Links ---
${JSON.stringify(uniqueLinks, null, 2)}

--- Header Tree Sequence & Content Sections ---
${JSON.stringify(headingsData, null, 2)}

--- Extracted Suspected Address & Business Hours HTML snippets ---
${JSON.stringify(semanticSnippets, null, 2)}

--- Existing Site Structure (Indexed Pages) ---
${JSON.stringify(siteStructure || [], null, 2)}

--- Known False Positives (confirmed correct by a human reviewer — DO NOT report these or anything substantially similar) ---
${priorLearnings || "(none recorded yet)"}
`;

      let result;

      if (provider === "local") {
        const { localLlmUrl, localLlmModel } = req.body;
        if (!localLlmUrl || !localLlmModel) {
           throw new Error("Local LLM URL and Model are required for local provider.");
        }
        
        const systemPrompt = `You are a strict, professional SEO and SOP Content Auditor. Your sole task is to analyze the requested webpage parts and return a single, valid JSON object matching this schema shape exactly.
Object schema shape:
{
  "mainTopic": "string descriptive overview of topic",
  "misplacedContent": [
    {
      "excerpt": "string quote from page content",
      "reason": "string detailed explanation why it is misplaced"
    }
  ],
  "linkIssues": [
    {
      "anchorText": "string anchor label / service name",
      "url": "string completely resolved absolute URL or 'none' if service detailing page link is missing/not linked",
      "section": "string area content location flag",
      "reason": "string explanation of issue or recommendation"
    }
  ],
  "headingIssues": [
    {
      "headingText": "string exact tag text",
      "tag": "string like H1/H2/H3",
      "issueType": "string: 'structure_skip', 'multiple_h1', 'capitalization', 'mismatched_content', or 'other'",
      "context": "string context info",
      "reason": "string reason details"
    }
  ],
  "semanticIssues": [
    {
      "elementContent": "string raw matched value text",
      "issueType": "string: 'address_missing_address_tag' or 'hours_missing_definition_list'",
      "reason": "string detail explaining standard HTML tags rules"
    }
  ]
}

Ensure you strictly obey capitalization rule of false positive checks.
EVERY issue object MUST contain a specific, non-empty "reason" string (and "context" where the schema has one) explaining clearly WHY it is an issue. NEVER output an empty string for "reason". If you cannot explain why something is a problem, then it is NOT a problem and you must omit it.
DO NOT include any prefix text, markdown formatting blocks (like \`\`\`json), backticks, or trailing chat. Return only the parsable JSON string.`;

        try {
          const localResponse = await fetch(localLlmUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: localLlmModel,
              prompt: systemPrompt + "\n\n" + auditPrompt,
              stream: false,
              format: "json", // Try to coerce JSON if supported by Ollama/Local API
              options: {
                temperature: 0.2,
                // Cap the context window. Modern Ollama models (llama3.x, qwen2.5)
                // default to a 128k window whose KV cache can need >16GB RAM and
                // fails to load on typical machines. This keeps memory reasonable
                // while staying large enough for the audit prompt. Override with
                // LOCAL_LLM_NUM_CTX if you have the RAM for more.
                num_ctx: Number(process.env.LOCAL_LLM_NUM_CTX) || 16384
              }
            })
          });

          if (!localResponse.ok) {
             const errBody = await localResponse.text().catch(() => "");
             throw new Error(`Local server responded with ${localResponse.status}${errBody ? `: ${errBody.slice(0, 300)}` : ""}`);
          }

          const localData = await localResponse.json();
          const textResponse = localData.response || localData.message?.content || localData.text || "{}";
            
          let jsonStr = textResponse.trim();
          if (jsonStr.startsWith("```json")) {
            jsonStr = jsonStr.substring(7);
          }
          if (jsonStr.startsWith("```")) {
            jsonStr = jsonStr.substring(3);
          }
          if (jsonStr.endsWith("```")) {
            jsonStr = jsonStr.substring(0, jsonStr.length - 3);
          }
          jsonStr = jsonStr.trim();
          
          result = JSON.parse(jsonStr);
        } catch (localErr: any) {
          console.error("Local LLM audit error:", localErr);
          throw new Error(`Local LLM audit failed: ${localErr.message || localErr}`);
        }
      } else {
        // gemini-2.5-flash-lite is reliably available on the free tier and fast;
        // gemini-2.5-flash is higher quality but more often rate-limited / 503 on
        // free keys. gemini-2.0-flash is NOT free-tier eligible (limit 0), so avoid it.
        const PRIMARY_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
        const FALLBACK_GEMINI_MODEL = "gemini-2.5-flash";

        // Free-tier Gemini frequently returns transient 503/UNAVAILABLE under
        // load. Try each model with a few backoff retries before giving up.
        const modelsToTry = [PRIMARY_GEMINI_MODEL, FALLBACK_GEMINI_MODEL];
        const MAX_RETRIES_PER_MODEL = 3;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const isTransient = (e: any) => {
          const status = e?.status ?? e?.code;
          const msg = String(e?.message ?? e ?? "");
          return status === 503 || status === 429 || /UNAVAILABLE|high demand|overload|RESOURCE_EXHAUSTED/i.test(msg);
        };

        let aiResponse: any;
        let lastErr: any;
        for (const model of modelsToTry) {
          let done = false;
          for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
            try {
              aiResponse = await ai.models.generateContent({
                model,
                contents: auditPrompt,
                config: {
                  responseMimeType: "application/json",
                  responseSchema: responseSchema,
                  temperature: 0.2
                }
              });
              done = true;
              break;
            } catch (err: any) {
              lastErr = err;
              if (isTransient(err) && attempt < MAX_RETRIES_PER_MODEL) {
                console.warn(`${model} attempt ${attempt} failed (transient). Backing off...`);
                await sleep(1500 * attempt);
                continue;
              }
              console.warn(`${model} failed after ${attempt} attempt(s); trying next model if available.`);
              break;
            }
          }
          if (done) break;
        }

        if (!aiResponse) {
          throw new Error(`AI service is temporarily unavailable due to high demand. Please try again in a moment. (Details: ${lastErr?.message || lastErr})`);
        }

        const jsonStr = aiResponse.text?.trim() || "{}";
        result = JSON.parse(jsonStr);
      }
      result.contentImages = contentImages;

      // Hard-filter findings the user previously confirmed as false positives.
      // This guarantees suppression on re-scans even if the model ignores the
      // prompt instruction (small local models often do).
      const learnedEntries = readLearningEntries(hostnameFromUrl(url));
      if (learnedEntries.length) {
        const isLearned = (category: string, item: any) =>
          learnedEntries.some((e) => e.category === category && e.identifier === issueIdentifier(category, item));
        if (Array.isArray(result.misplacedContent)) result.misplacedContent = result.misplacedContent.filter((i: any) => !isLearned("content", i));
        if (Array.isArray(result.headingIssues)) result.headingIssues = result.headingIssues.filter((i: any) => !isLearned("heading", i));
        if (Array.isArray(result.linkIssues)) result.linkIssues = result.linkIssues.filter((i: any) => !isLearned("link", i));
        if (Array.isArray(result.semanticIssues)) result.semanticIssues = result.semanticIssues.filter((i: any) => !isLearned("semantic", i));
      }

      res.json(result);
    } catch (error: any) {
      console.error(error);
      let clientMsg = error.message || "An unexpected error occurred.";
      if (clientMsg.includes("503") || clientMsg.includes("demand") || clientMsg.includes("UNAVAILABLE")) {
         clientMsg = "The AI model is currently experiencing very high demand or is temporarily unavailable. Please wait a brief moment and click Analyze again.";
      }
      res.status(500).json({ error: clientMsg });
    }
  });

  app.post("/api/test-local", async (req, res) => {
    try {
      const { url, model } = req.body;
      if (!url || !model) {
        return res.status(400).json({ error: "URL and Model are required" });
      }

      const localResponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          prompt: "Hello, this is a test. Reply with 'ok'.",
          stream: false,
          // Match the audit request's context cap so the test loads the model the
          // same way. Without this, modern Ollama models try to allocate a 128k
          // context and OOM (HTTP 500) on machines with limited RAM.
          options: {
            num_ctx: Number(process.env.LOCAL_LLM_NUM_CTX) || 16384
          }
        })
      });

      if (!localResponse.ok) {
        const errBody = await localResponse.text().catch(() => "");
        return res.status(localResponse.status).json({ error: `Server returned status ${localResponse.status}${errBody ? `: ${errBody.slice(0, 300)}` : ""}` });
      }

      const data = await localResponse.json();
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Connection failed" });
    }
  });

  // Record a confirmed false positive so future audits of this site learn from it.
  app.post("/api/feedback", async (req, res) => {
    try {
      const { url, category, identifier, aiReason, note } = req.body;
      if (!url || !category || !identifier) {
        return res.status(400).json({ error: "url, category and identifier are required" });
      }

      const hostname = hostnameFromUrl(url);
      let pathname = "/";
      try { pathname = new URL(url.startsWith("http") ? url : "https://" + url).pathname; } catch {}

      if (!fs.existsSync(LEARNINGS_DIR)) {
        fs.mkdirSync(LEARNINGS_DIR, { recursive: true });
      }
      const file = learningsFileFor(hostname);
      const isNew = !fs.existsSync(file);

      const clean = (s: any, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

      let block = "";
      if (isNew) {
        block += `# Audit Learnings — ${hostname}\n\n`;
        block += `Confirmed FALSE POSITIVES from manual review. The auditor MUST NOT report these issues (or substantially similar ones) again.\n\n`;
      }
      block += `- **[${clean(category, 30)}]** \`${clean(identifier, 300)}\` (on ${clean(pathname, 200)}) — confirmed correct / false positive; do not flag again.`;
      const reason = clean(aiReason, 250);
      if (reason) block += ` Previously the auditor wrongly claimed: "${reason}".`;
      const userNote = clean(note, 250);
      if (userNote) block += ` Reviewer note: ${userNote}`;
      block += `\n`;

      fs.appendFileSync(file, block, "utf-8");

      // Persist the structured entry for hard filtering on the next scan. The
      // client sends the already-composed identifier, so store it directly.
      const entries = readLearningEntries(hostname);
      if (!entries.some((e) => e.category === category && e.identifier === identifier)) {
        entries.push({ category: clean(category, 30), identifier: clean(identifier, 500) });
        fs.writeFileSync(learningsJsonFor(hostname), JSON.stringify(entries, null, 2), "utf-8");
      }

      res.json({ success: true, file: path.basename(file), hostname });
    } catch (err: any) {
      console.error("Feedback save error:", err);
      res.status(500).json({ error: err.message || "Failed to save feedback" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
