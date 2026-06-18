import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import * as cheerio from "cheerio";

// Initialize Gemini Client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

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
      const { url } = req.body;
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
                              description: "The specific anchor link text / word that contains the redirection or topic mismatch."
                          },
                          url: {
                              type: Type.STRING,
                              description: "The fully qualified target URL page is linking to."
                          },
                          section: {
                              type: Type.STRING,
                              description: "The surrounding context or section text where this link issue was identified."
                          },
                          reason: {
                              type: Type.STRING,
                              description: "Why this link appears to be redirecting to a suspicious, unexpected, or unrelated domain."
                          }
                      },
                      required: ["anchorText", "url", "section", "reason"]
                  },
                  description: "A list of identified redirect, shady, or entirely mismatched outgoing link issues found on the page."
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
                              description: "Detailed description of the issue under specified criteria (skipped heading, capitalization error, or mismatched paragraph content)."
                          }
                       },
                       required: ["headingText", "tag", "issueType", "reason"]
                  },
                  description: "A list of structural, capitalization, or content-match issues detected in the page's headings."
              }
          },
          required: ["mainTopic", "misplacedContent", "linkIssues", "headingIssues"]
      };

      const auditPrompt = `Analyze the following webpage content, links, and heading structure to identify inconsistencies, structural/hierarchical problems, capitalization formatting issues, or content mismatches.

Identify the main topic/purpose of the site.

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

--- Webpage text content ---
${textContent.substring(0, 30000)}

--- Extracted Outgoing Links ---
${JSON.stringify(uniqueLinks, null, 2)}

--- Header Tree Sequence & Content Sections ---
${JSON.stringify(headingsData, null, 2)}
`;

      let aiResponse;
      try {
        aiResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: auditPrompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: responseSchema,
                temperature: 0.2
            }
        });
      } catch (err: any) {
        console.warn("Primary model 'gemini-2.5-flash' failed or overloaded. Retrying with 'gemini-1.5-flash'...", err);
        try {
          aiResponse = await ai.models.generateContent({
              model: "gemini-1.5-flash",
              contents: auditPrompt,
              config: {
                  responseMimeType: "application/json",
                  responseSchema: responseSchema,
                  temperature: 0.2
              }
          });
        } catch (fallbackErr: any) {
          throw new Error(`AI service is temporarily unavailable due to high demand. Please try again. (Details: ${fallbackErr.message || fallbackErr})`);
        }
      }

      const jsonStr = aiResponse.text?.trim() || "{}";
      const result = JSON.parse(jsonStr);

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
