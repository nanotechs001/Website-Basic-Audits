import { useState, FormEvent, useRef, useMemo } from 'react';
import { 
  Search, 
  AlertTriangle, 
  CheckCircle, 
  Loader2, 
  Globe, 
  ExternalLink, 
  FileText, 
  Layout, 
  Sparkles, 
  Check, 
  X,
  Heading,
  TrendingUp,
  Clock,
  ArrowRight,
  StopCircle,
  HelpCircle,
  RefreshCw,
  Braces,
  Image as ImageIcon
} from 'lucide-react';
import { AuditResult, AuditError, PageAuditReport, ImageIssue } from './types';

export default function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [isCrawling, setIsCrawling] = useState(false);
  const [reports, setReports] = useState<PageAuditReport[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [crawlerStatus, setCrawlerStatus] = useState<string>('');
  const [showProgressBanner, setShowProgressBanner] = useState(true);
  const [individualRetryLoading, setIndividualRetryLoading] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'content' | 'headings' | 'links' | 'semantic' | 'images'>('content');
  const [provider, setProvider] = useState<'gemini' | 'local'>('gemini');
  const [localLlmUrl, setLocalLlmUrl] = useState('http://127.0.0.1:11434/api/generate');
  const [localLlmModel, setLocalLlmModel] = useState('llama3');
  const [testConnectionStatus, setTestConnectionStatus] = useState<{loading: boolean, success: boolean | null, message: string}>({loading: false, success: null, message: ''});

  // Prevent background state pollution and allow graceful stop
  const activeSessionIdRef = useRef<number>(0);

  const startAuditing = async (e: FormEvent) => {
    e.preventDefault();
    if (!url) return;

    let validUrl = url.trim();
    if (!validUrl.startsWith('http://') && !validUrl.startsWith('https://')) {
        validUrl = 'https://' + validUrl;
    }

    setLoading(true);
    setIsCrawling(true);
    setError(null);
    setReports([]);
    setSelectedUrl('');
    setCrawlerStatus('Discovering sitemap files and mapping URLs...');

    const sessionId = ++activeSessionIdRef.current;

    try {
      // Step 1: Query the /api/discover endpoint to fetch sitemap or fallback crawl paths
      const discoverResponse = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: validUrl }),
      });

      if (!discoverResponse.ok) {
        const errData = await discoverResponse.json();
        throw new Error(errData.error || 'Failed to map website structure.');
      }

      const discoverData = await discoverResponse.json();
      const discoveredPages = discoverData.pages as string[];

      if (!discoveredPages || discoveredPages.length === 0) {
        throw new Error('No crawlable pages were discovered from the target site.');
      }

      // Check for session race conditions
      if (activeSessionIdRef.current !== sessionId) return;

      const initialReports: PageAuditReport[] = discoveredPages.map((p) => ({
        url: p,
        result: null,
        error: null,
        status: p === discoveredPages[0] ? 'scanning' : 'pending'
      }));

      setReports(initialReports);
      setSelectedUrl(discoveredPages[0]);
      setShowProgressBanner(true);
      setLoading(false); // Stop block state and run crawling sequentially in background

      // Step 2: Audit each page
      let queue = [...discoveredPages];
      let completedCount = 0;
      let totalToAudit = discoveredPages.length;
      
      // Track attempts per URL to prevent absolute infinite loops on permanently unparsable pages
      const attemptCounts: Record<string, number> = {};
      discoveredPages.forEach(u => attemptCounts[u] = 0);
      const MAX_ATTEMPTS = 10;

      while (queue.length > 0) {
        if (activeSessionIdRef.current !== sessionId) return;

        const currentUrl = queue.shift()!;
        attemptCounts[currentUrl]++;
        
        // Update state to scanning
        setReports((prev) =>
          prev.map((r) =>
            r.url === currentUrl ? { ...r, status: 'scanning' } : r
          )
        );

        let success = false;
        let lastError = '';
        let auditData = null;

        if (attemptCounts[currentUrl] > 1) {
           setCrawlerStatus(`Retrying page: ${getRelativePath(currentUrl)} (Attempt ${attemptCounts[currentUrl]}/${MAX_ATTEMPTS})...`);
        } else {
           setCrawlerStatus(`Analyzing page: ${getRelativePath(currentUrl)}... (Completed ${completedCount}/${totalToAudit})`);
        }

        try {
          const auditResponse = await fetch('/api/audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: currentUrl, siteStructure: discoveredPages, provider, localLlmUrl, localLlmModel }),
          });

          if (activeSessionIdRef.current !== sessionId) return;

          const resData = await auditResponse.json();
          if (auditResponse.ok) {
            auditData = resData;
            success = true;
          } else {
            lastError = resData.error || 'Failed to complete audit';
            // If it's the known "high demand" error, make sure it is clearly flagged
            if (lastError.includes('capacity') || lastError.includes('limit') || lastError.includes('overload') || lastError.includes('unavailable') || lastError.includes('busy')) {
              lastError = "The AI model is currently experiencing very high demand or is temporarily unavailable.";
            }
          }
        } catch (err: any) {
          lastError = err.message || 'Network request timed out';
        }

        if (activeSessionIdRef.current !== sessionId) return;

        if (success && auditData) {
          completedCount++;
          setReports((prev) =>
            prev.map((r) =>
              r.url === currentUrl
                ? { ...r, status: 'completed', result: auditData as AuditResult, error: null }
                : r
            )
          );
        } else {
          // Re-queue if under max attempts
          if (attemptCounts[currentUrl] < MAX_ATTEMPTS) {
            queue.push(currentUrl);
            setReports((prev) =>
              prev.map((r) =>
                r.url === currentUrl
                  ? { ...r, status: 'failed', error: `Attempt ${attemptCounts[currentUrl]} failed: ${lastError}. Re-queued...` }
                  : r
              )
            );
            setCrawlerStatus(`Error on ${getRelativePath(currentUrl)}, re-queueing to the back...`);
          } else {
            completedCount++; // Give up and move on
            setReports((prev) =>
              prev.map((r) =>
                r.url === currentUrl
                  ? { ...r, status: 'failed', error: `Failed after ${MAX_ATTEMPTS} attempts: ${lastError}` }
                  : r
              )
            );
          }
        }

        // Rest delay between page audits to keep server and connections healthy
        if (queue.length > 0) {
          if (activeSessionIdRef.current !== sessionId) return;
          setCrawlerStatus(`Allowing connection to rest before next page... (Completed ${completedCount}/${totalToAudit} unique pages)`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      if (activeSessionIdRef.current === sessionId) {
        setCrawlerStatus('Sitemap and pathway audits completed!');
        setIsCrawling(false);
        playSuccessSound();
        // Hide the progress banner automatically after 6 seconds
        setTimeout(() => {
          if (activeSessionIdRef.current === sessionId) {
            setShowProgressBanner(false);
          }
        }, 6000);
      }
    } catch (err: any) {
      if (activeSessionIdRef.current === sessionId) {
        setError(err.message || 'An error occurred during discovery.');
        setLoading(false);
        setIsCrawling(false);
      }
    }
  };

  const playSuccessSound = async () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      
      // Resume context if suspended (browser security restriction fallback)
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      
      // Elegant UI chime: Tone 1 (high C)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(523.25, ctx.currentTime); 
      gain1.gain.setValueAtTime(0.12, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.35);

      // Tone 2 (E) shortly after for harmonious chime resolution
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(659.25, ctx.currentTime + 0.12); 
      gain2.gain.setValueAtTime(0.12, ctx.currentTime + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
      
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(ctx.currentTime + 0.12);
      osc2.stop(ctx.currentTime + 0.55);
    } catch (e) {
      console.warn("Could not play synthesized audio notification:", e);
    }
  };

  const retryIndividualAudit = async (targetUrl: string) => {
    const index = reports.findIndex((r) => r.url === targetUrl);
    if (index === -1) return;

    setIndividualRetryLoading(targetUrl);
    setReports((prev) =>
      prev.map((r, idx) =>
        idx === index ? { ...r, status: 'scanning', error: null } : r
      )
    );

    let success = false;
    let retryAttempts = 3;
    let lastError = '';
    let auditData = null;

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
      try {
        const auditResponse = await fetch('/api/audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: targetUrl, siteStructure: reports.map((r) => r.url), provider }),
        });

        const resData = await auditResponse.json();
        if (auditResponse.ok) {
          auditData = resData;
          success = true;
          break;
        } else {
          lastError = resData.error || 'Failed to complete audit';
          if (lastError.includes('capacity') || lastError.includes('limit') || lastError.includes('overload') || lastError.includes('unavailable') || lastError.includes('busy')) {
            lastError = "The AI model is currently experiencing very high demand or is temporarily unavailable. Please wait a brief moment and click Retry.";
          }
        }
      } catch (err: any) {
        lastError = err.message || 'Network request timed out';
      }

      if (attempt < retryAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    setIndividualRetryLoading(null);
    if (success && auditData) {
      setReports((prev) =>
        prev.map((r, idx) =>
          idx === index
            ? { ...r, status: 'completed', result: auditData as AuditResult, error: null }
            : r
        )
      );
      playSuccessSound();
    } else {
      setReports((prev) =>
        prev.map((r, idx) =>
          idx === index
            ? { ...r, status: 'failed', error: lastError }
            : r
        )
      );
    }
  };

  const stopAuditing = () => {
    activeSessionIdRef.current = ++activeSessionIdRef.current;
    setIsCrawling(false);
    setCrawlerStatus('Audit paused by user.');
    setReports((prev) =>
      prev.map((r) =>
        r.status === 'pending' || r.status === 'scanning'
          ? { ...r, status: 'failed', error: 'Scanning stopped' }
          : r
      )
    );
    // Hide progress bar shortly after stopping
    setTimeout(() => {
      setShowProgressBanner(false);
    }, 5000);
  };

  const getRelativePath = (fullUrl: string) => {
    try {
      const u = new URL(fullUrl);
      return u.pathname === '/' ? '/' : u.pathname;
    } catch (e) {
      return fullUrl;
    }
  };

  const auditedReports = useMemo<PageAuditReport[]>(() => {
    return reports.map((report) => {
      if (report.status !== 'completed' || !report.result) return report;
      
      const contentImages = report.result.contentImages || [];
      const localSrcCounts: { [src: string]: number } = {};
      
      contentImages.forEach((img) => {
        localSrcCounts[img.src] = (localSrcCounts[img.src] || 0) + 1;
      });

      const otherPagesWithImg: { [src: string]: string[] } = {};
      reports.forEach((other) => {
        if (other.url === report.url || other.status !== 'completed' || !other.result) return;
        const otherImages = other.result.contentImages || [];
        otherImages.forEach((oImg) => {
          if (!otherPagesWithImg[oImg.src]) {
            otherPagesWithImg[oImg.src] = [];
          }
          if (!otherPagesWithImg[oImg.src].includes(other.url)) {
            otherPagesWithImg[oImg.src].push(other.url);
          }
        });
      });

      const imageIssues: ImageIssue[] = [];
      const uniqueSrcs: string[] = Array.from(new Set(contentImages.map((img) => img.src as string)));

      uniqueSrcs.forEach((src: string) => {
        const matches = contentImages.filter(img => img.src === src);
        const firstMatch = matches[0];
        const count = matches.length;
        const others = otherPagesWithImg[src] || [];

        // 1. Same-Page Duplication
        if (count > 1) {
          imageIssues.push({
            src,
            alt: firstMatch?.alt || "No descriptive alt text provided",
            duplicationType: 'same_page',
            occurrences: count,
            reason: `This custom content image is displayed ${count} times on this single page. Redundant visual content blocks detract from modern visual design standards, slow browser layout performance, and offer a poor user experience.`,
            recommendation: `Consolidate repeating sections, replace extra occurrences with contextual graphics or custom illustration elements, or use CSS sprites/classes if they represent visual icons.`
          });
        }

        // 2. Cross-Page Duplication (Global Site Context)
        if (others.length > 0) {
          imageIssues.push({
            src,
            alt: firstMatch?.alt || "No descriptive alt text provided",
            duplicationType: 'cross_page',
            occurrences: count + others.length,
            otherPages: others,
            reason: `This content image is reused identically across ${others.length} other page(s) of this website. Excessive duplication of media assets across separate URLs dilutes organic visual SEO and reduces search engine crawl efficiency.`,
            recommendation: `Introduce distinct bespoke visual figures for each unique page context. Structural corporate branding/logos are safely skipped automatically, but distinct page context image bodies require unique files.`
          });
        }
      });

      return {
        ...report,
        result: {
          ...report.result,
          imageIssues
        }
      };
    });
  }, [reports]);

  // Derived dashboard statistics
  const selectedReport = auditedReports.find((r) => r.url === selectedUrl);
  const totalHeadingIssues = selectedReport?.result?.headingIssues?.length || 0;
  const totalLinkIssues = selectedReport?.result?.linkIssues?.length || 0;
  const totalContentIssues = selectedReport?.result?.misplacedContent?.length || 0;
  const totalSemanticIssues = selectedReport?.result?.semanticIssues?.length || 0;
  const totalImageIssues = selectedReport?.result?.imageIssues?.length || 0;

  const healthScore = selectedReport?.result
    ? Math.max(0, Math.min(100, 100 - (totalHeadingIssues * 6 + totalLinkIssues * 15 + totalContentIssues * 10 + totalSemanticIssues * 10 + totalImageIssues * 12)))
    : 100;

  // Queue progression calculations
  const totalPages = reports.length;
  const completedPagesCount = reports.filter((r) => r.status === 'completed' || r.status === 'failed').length;
  const percentComplete = totalPages > 0 ? Math.round((completedPagesCount / totalPages) * 100) : 0;

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans selection:bg-blue-100 p-4 sm:p-8">
      <div className="max-w-6xl mx-auto space-y-8 mt-6 sm:mt-12">
        
        {/* Header Section */}
        <header className="text-center space-y-3">
          <div className="inline-flex items-center justify-center p-3 bg-blue-50 text-blue-600 rounded-2xl shadow-sm border border-blue-100">
            <Globe size={28} className={isCrawling ? "animate-spin" : ""} />
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-neutral-900">
            Website Content Auditor
          </h1>
          <p className="text-sm sm:text-base text-neutral-500 max-w-xl mx-auto leading-relaxed">
            Scan website outlines and sitemaps page-by-page. Automatically detect sequence skips, capitalization faults, off-topic paragraphs, and malicious redirect links.
          </p>
        </header>

        {/* Input Form Controls */}
        <div className="space-y-3 max-w-2xl mx-auto">
          <form onSubmit={startAuditing} className="relative shadow-md rounded-2xl bg-white border border-neutral-200 overflow-hidden flex transition-all focus-within:ring-2 focus-within:ring-blue-500/50">
            <div className="flex items-center pl-4 text-neutral-400">
              <Search size={20} />
            </div>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://pattersonfamilysmiles.viziglobal.com"
              disabled={loading || isCrawling}
              required
              className="flex-1 min-w-0 bg-transparent px-4 py-4 text-sm sm:text-base text-neutral-800 placeholder-neutral-400 focus:outline-none disabled:opacity-75"
            />
            {isCrawling ? (
              <button
                type="button"
                onClick={stopAuditing}
                className="px-5 py-4 bg-red-50 hover:bg-red-100 text-red-600 font-semibold transition-colors flex items-center gap-2 text-sm sm:text-base border-l border-neutral-200"
              >
                <StopCircle size={18} />
                <span className="hidden sm:inline">Stop Scan</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={loading || !url}
                className="px-6 py-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm sm:text-base"
              >
                {loading ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    <span>Mapping...</span>
                  </>
                ) : (
                  <span>Analyze Site</span>
                )}
              </button>
            )}
          </form>

          {/* Provider Selection */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-3 rounded-2xl border border-neutral-200 shadow-sm">
            <span className="text-xs font-bold text-neutral-500 uppercase tracking-wider pl-1.5">
              AI Auditor Engine:
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => !loading && !isCrawling && setProvider('gemini')}
                disabled={loading || isCrawling}
                className={`text-xs font-semibold px-3.5 py-2 rounded-xl border transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                  provider === 'gemini'
                    ? 'bg-blue-50 text-blue-700 border-blue-200 shadow-sm font-bold'
                    : 'bg-neutral-50 text-neutral-600 border-neutral-200 hover:bg-neutral-100'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                <span>Google Gemini 3.5</span>
              </button>
              <button
                type="button"
                onClick={() => !loading && !isCrawling && setProvider('local')}
                disabled={loading || isCrawling}
                className={`text-xs font-semibold px-3.5 py-2 rounded-xl border transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                  provider === 'local'
                    ? 'bg-purple-50 text-purple-800 border-purple-200 shadow-sm font-bold'
                    : 'bg-neutral-50 text-neutral-600 border-neutral-200 hover:bg-neutral-100'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-purple-500 animate-pulse" />
                <span>Local LLM</span>
              </button>
            </div>
          </div>

          {/* Quick Info */}
          <div className="flex flex-col gap-2 pt-1">
            {provider === 'local' && (
              <div className="bg-purple-50/50 border border-purple-100 p-3 rounded-2xl animate-in fade-in duration-300 space-y-3">
                <div className="text-[11px] text-purple-800 leading-relaxed font-medium">
                  Provide your local LLM inference server endpoint (e.g., Ollama or standard OpenAI-compatible API).
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <input
                    type="url"
                    value={localLlmUrl}
                    onChange={(e) => setLocalLlmUrl(e.target.value)}
                    disabled={loading || isCrawling}
                    className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-purple-200 bg-white focus:outline-none focus:ring-2 focus:ring-purple-500/20 disabled:opacity-50"
                    placeholder="Endpoint URL (e.g., http://127.0.0.1:11434/api/generate)"
                  />
                  <input
                    type="text"
                    value={localLlmModel}
                    onChange={(e) => setLocalLlmModel(e.target.value)}
                    disabled={loading || isCrawling}
                    className="w-full sm:w-32 px-3 py-1.5 text-xs rounded-lg border border-purple-200 bg-white focus:outline-none focus:ring-2 focus:ring-purple-500/20 disabled:opacity-50"
                    placeholder="Model (e.g. llama3)"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      setTestConnectionStatus({ loading: true, success: null, message: '' });
                      try {
                        const res = await fetch('/api/test-local', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ url: localLlmUrl, model: localLlmModel })
                        });
                        const data = await res.json();
                        if (res.ok && data.success) {
                          setTestConnectionStatus({ loading: false, success: true, message: 'Connection successful!' });
                        } else {
                          setTestConnectionStatus({ loading: false, success: false, message: data.error || 'Connection failed' });
                        }
                      } catch (e: any) {
                        setTestConnectionStatus({ loading: false, success: false, message: e.message || 'Network error' });
                      }
                    }}
                    disabled={testConnectionStatus.loading || loading || isCrawling}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-600 hover:bg-purple-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
                  >
                    {testConnectionStatus.loading ? 'Testing...' : 'Test Connection'}
                  </button>
                </div>
                {testConnectionStatus.success !== null && (
                  <div className={`text-[10px] font-bold ${testConnectionStatus.success ? 'text-emerald-600' : 'text-red-600'}`}>
                    {testConnectionStatus.success ? '✅ ' : '❌ '} {testConnectionStatus.message}
                  </div>
                )}
              </div>
            )}
            
            <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs">
              <div className="flex items-center gap-1.5 text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full font-medium border border-blue-100">
                <span className="relative flex h-1.5 w-1.5 animate-pulse">
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500"></span>
                </span>
                <span>🔒 Auditing is sequential with rests to prevent rate limits & connection timeouts</span>
              </div>
            </div>
          </div>
        </div>

        {/* Crawler Status Progression Alert */}
        {showProgressBanner && crawlerStatus && (
          <div className="bg-white rounded-xl p-4 border border-neutral-200 max-w-2xl mx-auto shadow-sm space-y-3 relative">
            <button
              onClick={() => setShowProgressBanner(false)}
              className="absolute top-2.5 right-2.5 text-neutral-400 hover:text-neutral-600 p-1 rounded-lg hover:bg-neutral-100 transition-colors cursor-pointer"
              title="Dismiss Status Bar"
            >
              <X size={15} />
            </button>
            <div className="flex items-center justify-between text-xs font-semibold text-neutral-500 pr-5">
              <span className="flex items-center gap-1.5 min-w-0 pr-2">
                <Loader2 size={14} className="animate-spin text-blue-600 shrink-0" />
                <span className="truncate">{crawlerStatus}</span>
              </span>
              <span className="shrink-0">{completedPagesCount} / {totalPages} Pages ({percentComplete}%)</span>
            </div>
            <div className="w-full bg-neutral-100 h-2 rounded-full overflow-hidden border border-neutral-200/50">
              <div 
                className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 transition-all duration-500"
                style={{ width: `${percentComplete}%` }}
              />
            </div>
          </div>
        )}

        {/* Global Error message */}
        {error && (
          <div className="max-w-2xl mx-auto bg-red-50 text-red-700 p-4 rounded-xl border border-red-100 flex items-start gap-3 animate-in fade-in duration-300 shadow-sm">
            <AlertTriangle className="shrink-0 mt-0.5" size={20} />
            <div className="space-y-1">
              <span className="font-semibold block">Discovery Cancelled</span>
              <p className="text-sm">{error}</p>
            </div>
          </div>
        )}

        {/* Main Content Dashboard - Show when reports exist */}
        {reports.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
            
            {/* Sidebar Columns - Pages List Navigation */}
            <aside className="lg:col-span-1 bg-white rounded-2xl border border-neutral-200 p-4 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-neutral-400">Pages Discovered</span>
                <span className="bg-neutral-100 text-neutral-600 text-xs px-2 py-0.5 rounded-full font-mono font-semibold">
                  {reports.length}
                </span>
              </div>

              <div className="space-y-1.5 max-h-[460px] overflow-y-auto pr-1">
                {auditedReports.map((report) => {
                  const isActive = report.url === selectedUrl;
                  return (
                    <button
                      key={report.url}
                      onClick={() => setSelectedUrl(report.url)}
                      className={`w-full text-left p-2.5 rounded-xl border text-xs transition-all flex items-start justify-between gap-2.5 focus:outline-none ${
                        isActive
                          ? 'bg-blue-50 border-blue-200 text-blue-900 font-semibold'
                          : 'bg-white border-neutral-100 hover:bg-neutral-50 text-neutral-600 hover:border-neutral-200'
                      }`}
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <span className="block truncate font-mono">
                          {getRelativePath(report.url)}
                        </span>
                        <span className="block text-[10px] text-neutral-400 font-sans truncate" title={report.url}>
                          {report.url}
                        </span>

                        {report.status === 'completed' && report.result && (
                          <div className="flex flex-wrap gap-1 pt-1.5" onClick={(e) => e.stopPropagation()}>
                            <span 
                              className={`px-1 py-0.5 rounded text-[10px] font-medium border flex items-center gap-0.5 ${
                                (report.result.misplacedContent?.length || 0) > 0 
                                  ? 'bg-amber-50 text-amber-700 border-amber-100' 
                                  : 'bg-neutral-50 text-neutral-400 border-neutral-100'
                              }`}
                              title="Misplaced Content count"
                            >
                              M: {report.result.misplacedContent?.length || 0}
                            </span>
                            <span 
                              className={`px-1 py-0.5 rounded text-[10px] font-medium border flex items-center gap-0.5 ${
                                (report.result.headingIssues?.length || 0) > 0 
                                  ? 'bg-blue-50 text-blue-700 border-blue-100' 
                                  : 'bg-neutral-50 text-neutral-400 border-neutral-100'
                              }`}
                              title="Heading Issues count"
                            >
                              H: {report.result.headingIssues?.length || 0}
                            </span>
                            <span 
                              className={`px-1 py-0.5 rounded text-[10px] font-medium border flex items-center gap-0.5 ${
                                (report.result.linkIssues?.length || 0) > 0 
                                  ? 'bg-rose-50 text-rose-700 border-rose-100' 
                                  : 'bg-neutral-50 text-neutral-400 border-neutral-100'
                              }`}
                              title="Link Issues count"
                            >
                              L: {report.result.linkIssues?.length || 0}
                            </span>
                            <span 
                              className={`px-1 py-0.5 rounded text-[10px] font-medium border flex items-center gap-0.5 ${
                                (report.result.semanticIssues?.length || 0) > 0 
                                  ? 'bg-purple-50 text-purple-700 border-purple-100' 
                                  : 'bg-neutral-50 text-neutral-400 border-neutral-100'
                              }`}
                              title="Semantic HTML Issues count"
                            >
                              S: {report.result.semanticIssues?.length || 0}
                            </span>
                            <span 
                              className={`px-1 py-0.5 rounded text-[10px] font-medium border flex items-center gap-0.5 ${
                                (report.result.imageIssues?.length || 0) > 0 
                                  ? 'bg-violet-100 text-violet-800 border-violet-200' 
                                  : 'bg-neutral-50 text-neutral-400 border-neutral-100'
                              }`}
                              title="Image Duplicate Issues count"
                            >
                              I: {report.result.imageIssues?.length || 0}
                            </span>
                          </div>
                        )}

                        {report.status === 'failed' && (
                          <div className="text-[10px] text-red-500 pt-1 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                            <span>Scanned failed</span>
                            {individualRetryLoading === report.url ? (
                              <Loader2 size={10} className="animate-spin text-red-500" />
                            ) : (
                              <button
                                onClick={() => retryIndividualAudit(report.url)}
                                className="text-blue-600 hover:underline flex items-center gap-0.5 font-bold bg-neutral-100 hover:bg-neutral-200 px-1 py-0.5 rounded border border-neutral-200 cursor-pointer"
                              >
                                <RefreshCw size={8} />
                                <span>Retry</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Status Indicator */}
                      <div className="shrink-0 pt-0.5">
                        {report.status === 'pending' && (
                          <div className="h-2 w-2 rounded-full bg-neutral-300" title="Queued" />
                        )}
                        {report.status === 'scanning' && (
                          <Loader2 size={14} className="animate-spin text-blue-500" />
                        )}
                        {report.status === 'completed' && (
                          <div className="h-2 w-2 rounded-full bg-emerald-500" title="Audit Completed" />
                        )}
                        {report.status === 'failed' && (
                          <div className="h-2 w-2 rounded-full bg-red-500" title="Failed / Stopped" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="text-[10px] text-neutral-400 text-center flex items-center justify-center gap-1">
                <HelpCircle size={12} />
                <span>Click a page to explore its results at any time.</span>
              </div>
            </aside>

            {/* Main Area Column - Displays Audit Report of Selected URL */}
            <main className="lg:col-span-3 space-y-6">
              
              {selectedReport ? (
                <>
                  {/* Selected Page Title & URL */}
                  <div className="bg-white rounded-2xl border border-neutral-200 p-5 shadow-sm space-y-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <span className="text-xs font-semibold text-blue-600 tracking-wider uppercase">Currently Inspecting</span>
                      <h2 className="text-xl font-bold text-neutral-900 break-words font-mono">
                        {getRelativePath(selectedReport.url)}
                      </h2>
                      <div className="flex items-center gap-1.5 text-xs text-neutral-500 min-w-0">
                        <Globe size={13} className="shrink-0" />
                        <a 
                          href={selectedReport.url} 
                          target="_blank" 
                          rel="noreferrer" 
                          className="hover:underline hover:text-blue-600 truncate flex items-center gap-1 min-w-0"
                        >
                          <span className="truncate">{selectedReport.url}</span>
                          <ExternalLink size={11} className="shrink-0" />
                        </a>
                      </div>
                    </div>

                    <div className="shrink-0">
                      {selectedReport.status === 'pending' && (
                        <span className="inline-flex items-center gap-1 px-3 py-1 bg-neutral-100 text-neutral-600 text-xs font-semibold rounded-full border border-neutral-200">
                          <Clock size={12} /> Queued
                        </span>
                      )}
                      {selectedReport.status === 'scanning' && (
                        <span className="inline-flex items-center gap-1 px-3 py-1 bg-blue-50 text-blue-600 text-xs font-semibold rounded-full border border-blue-100 animate-pulse">
                          <Loader2 size={12} className="animate-spin" /> Analyzing Content...
                        </span>
                      )}
                      {selectedReport.status === 'completed' && (
                        <span className="inline-flex items-center gap-1 px-3 py-1 bg-emerald-50 text-emerald-700 text-xs font-semibold rounded-full border border-emerald-100">
                          <CheckCircle size={12} /> Live Audit Ready
                        </span>
                      )}
                      {selectedReport.status === 'failed' && (
                        <span className="inline-flex items-center gap-1 px-3 py-1 bg-red-50 text-red-700 text-xs font-semibold rounded-full border border-red-100">
                          <AlertTriangle size={12} /> Audit Incomplete
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 1. Page is Waiting or Queued / Scanning */}
                  {selectedReport.status === 'pending' && (
                    <div className="bg-white rounded-2xl border border-neutral-200 p-12 text-center text-neutral-500 space-y-4 shadow-sm">
                      <Clock className="mx-auto text-neutral-300 animate-bounce" size={48} />
                      <div className="space-y-1">
                        <h4 className="text-lg font-bold text-neutral-800">Page Queued in Sequencer</h4>
                        <p className="text-sm max-w-sm mx-auto text-neutral-500">
                          To avoid server firewalls, pages are analyzed one-by-one. This page will be parsed automatically soon.
                        </p>
                      </div>
                    </div>
                  )}

                  {selectedReport.status === 'scanning' && !selectedReport.result && (
                    <div className="bg-white rounded-2xl border border-neutral-200 p-12 text-center text-neutral-500 space-y-4 shadow-sm animate-pulse">
                      <Loader2 className="mx-auto text-blue-500 animate-spin" size={48} />
                      <div className="space-y-1">
                        <h4 className="text-lg font-bold text-neutral-800">Analyzing Page Content...</h4>
                        <p className="text-sm max-w-sm mx-auto text-neutral-500">
                          The auditor is scanning the HTML header outline, reviewing casing alignment, checking outbound links, and resolving topics...
                        </p>
                      </div>
                    </div>
                  )}

                  {/* 2. Page has errors in execution */}
                  {selectedReport.status === 'failed' && (
                    <div className="bg-red-50 text-red-700 p-6 rounded-2xl border border-red-100 flex flex-col md:flex-row items-stretch md:items-start gap-4 shadow-sm">
                      <div className="flex items-start gap-3 flex-1 animate-in fade-in duration-300">
                        <AlertTriangle className="shrink-0 mt-0.5 text-red-505" size={24} />
                        <div className="space-y-2">
                          <h4 className="font-bold text-base text-red-950">Unable to Audit Path</h4>
                          <p className="text-sm leading-relaxed text-red-700">
                            {selectedReport.error || 'The page was skipped or timed out due to unstable network response or restricted access privileges.'}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center justify-end">
                        {individualRetryLoading === selectedReport.url ? (
                          <button
                            type="button"
                            disabled
                            className="w-full md:w-auto px-5 py-2.5 bg-red-100 text-red-600 font-semibold rounded-xl border border-red-200 flex items-center justify-center gap-2 text-sm"
                          >
                            <Loader2 size={16} className="animate-spin text-red-500" />
                            <span>Retrying Audit...</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => retryIndividualAudit(selectedReport.url)}
                            className="w-full md:w-auto px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 text-sm cursor-pointer whitespace-nowrap"
                          >
                            <RefreshCw size={14} />
                            <span>Retry Page Scan</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 3. Page has completed successfully */}
                  {selectedReport.result && (
                    <div className="space-y-6">
                      
                      {/* Topic cohesion score header */}
                      <section className="bg-white rounded-2xl p-6 border border-neutral-200 shadow-sm grid grid-cols-1 md:grid-cols-3 gap-6 relative overflow-hidden">
                        <div className="md:col-span-2 space-y-4">
                          <div className="flex items-center gap-2 text-xs font-semibold tracking-wider text-neutral-400 uppercase">
                            <Sparkles size={14} className="text-blue-500 animate-pulse" />
                            Audited Topic Focus
                          </div>
                          <div className="space-y-1.5">
                            <h3 className="text-lg font-bold text-neutral-900">
                              Identified Purpose
                            </h3>
                            <p className="text-neutral-600 text-sm leading-relaxed italic border-l-4 border-blue-500 pl-4 py-1">
                              "{selectedReport.result.mainTopic}"
                            </p>
                          </div>
                        </div>

                        {/* Local Health Card */}
                        <div className="flex flex-col items-center justify-center bg-neutral-50 p-4 rounded-xl border border-neutral-100 text-center space-y-2">
                          <span className="text-[10px] font-semibold text-neutral-400 tracking-wider uppercase">Page Score</span>
                          <div className={`text-4xl font-black ${healthScore > 80 ? 'text-emerald-600' : healthScore > 50 ? 'text-amber-500' : 'text-red-600'}`}>
                            {healthScore}%
                          </div>
                          <div className="w-full bg-neutral-200 h-1 rounded-full overflow-hidden">
                            <div 
                              className={`h-full rounded-full ${healthScore > 80 ? 'bg-emerald-500' : healthScore > 50 ? 'bg-amber-500' : 'bg-red-500'}`}
                              style={{ width: `${healthScore}%` }}
                            />
                          </div>
                        </div>
                      </section>

                      {/* Tab controller for page audit results */}
                      <div className="border-b border-neutral-200 flex flex-wrap gap-1">
                        <button
                          onClick={() => setActiveTab('content')}
                          className={`pb-3 px-4 font-semibold text-xs sm:text-sm transition-all focus:outline-none flex items-center gap-2 border-b-2 -mb-[2px] ${
                            activeTab === 'content'
                              ? 'border-blue-600 text-blue-600'
                              : 'border-transparent text-neutral-500 hover:text-neutral-800'
                          }`}
                        >
                          <FileText size={16} />
                          <span>Misplaced ({totalContentIssues})</span>
                        </button>

                        <button
                          onClick={() => setActiveTab('headings')}
                          className={`pb-3 px-4 font-semibold text-xs sm:text-sm transition-all focus:outline-none flex items-center gap-2 border-b-2 -mb-[2px] ${
                            activeTab === 'headings'
                              ? 'border-blue-600 text-blue-600'
                              : 'border-transparent text-neutral-500 hover:text-neutral-800'
                          }`}
                        >
                          <Heading size={16} />
                          <span>Headings ({totalHeadingIssues})</span>
                        </button>

                        <button
                          onClick={() => setActiveTab('links')}
                          className={`pb-3 px-4 font-semibold text-xs sm:text-sm transition-all focus:outline-none flex items-center gap-2 border-b-2 -mb-[2px] ${
                            activeTab === 'links'
                              ? 'border-blue-600 text-blue-600'
                              : 'border-transparent text-neutral-500 hover:text-neutral-800'
                          }`}
                        >
                          <ExternalLink size={16} />
                          <span>Links ({totalLinkIssues})</span>
                        </button>

                        <button
                          onClick={() => setActiveTab('semantic')}
                          className={`pb-3 px-4 font-semibold text-xs sm:text-sm transition-all focus:outline-none flex items-center gap-2 border-b-2 -mb-[2px] ${
                            activeTab === 'semantic'
                              ? 'border-blue-600 text-blue-600'
                              : 'border-transparent text-neutral-500 hover:text-neutral-800'
                          }`}
                        >
                          <Braces size={16} />
                          <span>Semantic HTML ({totalSemanticIssues})</span>
                        </button>

                        <button
                          onClick={() => setActiveTab('images')}
                          className={`pb-3 px-4 font-semibold text-xs sm:text-sm transition-all focus:outline-none flex items-center gap-2 border-b-2 -mb-[2px] ${
                            activeTab === 'images'
                              ? 'border-blue-600 text-blue-600'
                              : 'border-transparent text-neutral-500 hover:text-neutral-800'
                          }`}
                        >
                          <ImageIcon size={16} />
                          <span>Image Duplicates ({totalImageIssues})</span>
                        </button>
                      </div>

                      {/* TAB CONTENTS RENDERER */}

                      {/* Tab 1: Misplaced Content */}
                      {activeTab === 'content' && (
                        <div className="space-y-4 animate-in fade-in duration-300">
                          {totalContentIssues === 0 ? (
                            <div className="bg-emerald-50/50 border border-emerald-100 rounded-2xl p-8 text-center text-emerald-800 space-y-2">
                                <CheckCircle className="mx-auto text-emerald-500 animate-bounce" size={28} />
                                <p className="font-semibold text-sm">Perfect Content Cohesion</p>
                                <p className="text-xs text-emerald-600/90">AI detected no stray topic segments or irrelevant sentences on this page.</p>
                            </div>
                          ) : (
                            <div className="grid gap-3">
                               {selectedReport.result.misplacedContent.map((item, index) => (
                                   <div key={index} className="bg-white rounded-xl p-4 sm:p-5 border border-neutral-200 shadow-sm flex items-start gap-4">
                                       <div className="mt-0.5 bg-amber-50 text-amber-600 p-1.5 rounded-lg shrink-0 border border-amber-100">
                                           <AlertTriangle size={16} />
                                       </div>
                                       <div className="space-y-2 min-w-0 flex-1">
                                           <blockquote className="text-neutral-600 italic border-l-2 border-neutral-200 pl-3 py-0.5 text-xs bg-neutral-50/50 pr-4 break-words">
                                               "{item.excerpt}"
                                           </blockquote>
                                           <p className="text-xs text-neutral-700 font-medium bg-neutral-50/80 py-1.5 px-3 rounded-lg leading-relaxed">
                                               <span className="text-amber-700 font-bold">Analysis Feedback:</span> {item.reason}
                                           </p>
                                       </div>
                                   </div>
                               ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Tab 2: Headings structure & Capitalization */}
                      {activeTab === 'headings' && (
                        <div className="space-y-4 animate-in fade-in duration-300">
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-[10px] bg-neutral-100 p-3 rounded-xl border border-neutral-200 text-neutral-500">
                            <div className="flex items-center gap-1.5">
                              <Check size={12} className="text-emerald-500" />
                              <span>Only one H1 tag permitted</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Check size={12} className="text-emerald-500" />
                              <span>No level sequence skips e.g. H2 to H4</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Check size={12} className="text-emerald-500" />
                              <span>Standard casing matching strict guidelines</span>
                            </div>
                          </div>

                          {totalHeadingIssues === 0 ? (
                            <div className="bg-emerald-50/50 border border-emerald-100 rounded-2xl p-8 text-center text-emerald-800 space-y-2">
                                <CheckCircle className="mx-auto text-emerald-500 animate-bounce" size={28} />
                                <p className="font-semibold text-sm">HTML Outline is Flawless!</p>
                                <p className="text-xs text-emerald-600/90">No hierarchy skips, multiple H1, title mismatches, or capitalization violations detected.</p>
                            </div>
                          ) : (
                            <div className="grid gap-3">
                               {selectedReport.result.headingIssues.map((item, index) => {
                                   let badgeColor = "bg-neutral-100 text-neutral-700 border-neutral-200";
                                   let label = "Issue";
                                   if (item.issueType === "structure_skip") {
                                      badgeColor = "bg-orange-50 text-orange-700 border-orange-100";
                                      label = "Nesting Skip";
                                   } else if (item.issueType === "multiple_h1") {
                                      badgeColor = "bg-red-50 text-red-700 border-red-100";
                                      label = "Extra H1";
                                   } else if (item.issueType === "capitalization") {
                                      badgeColor = "bg-blue-50 text-blue-700 border-blue-100";
                                      label = "Case Fault";
                                   } else if (item.issueType === "mismatched_content") {
                                      badgeColor = "bg-violet-50 text-violet-700 border-violet-100";
                                      label = "Content Divergence";
                                   }

                                   return (
                                      <div key={index} className="bg-white rounded-xl p-4 sm:p-5 border border-neutral-200 shadow-sm flex flex-col sm:flex-row items-start gap-3 hover:border-neutral-300 transition-colors">
                                          <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded border shrink-0 uppercase tracking-widest ${badgeColor}`}>
                                              {label}
                                          </span>
                                          <div className="space-y-2 min-w-0 flex-1">
                                              <div className="flex flex-wrap items-center gap-2">
                                                  <span className="font-mono text-[10px] text-neutral-400 border border-neutral-200 px-1.5 py-0.5 rounded bg-neutral-50 font-bold">
                                                      {item.tag}
                                                  </span>
                                                  <h4 className="font-bold text-neutral-800 break-words text-sm">
                                                      "{item.headingText}"
                                                  </h4>
                                              </div>
                                              
                                              {item.context && (
                                                  <div className="text-[11px] text-neutral-500 bg-neutral-50 p-2.5 rounded border border-neutral-100 italic">
                                                      <span className="font-semibold not-italic block pb-0.5 text-neutral-600 text-[10px]">Reference contextual text content:</span>
                                                      "{item.context}"
                                                  </div>
                                              )}

                                              <p className="text-xs font-medium text-neutral-700 bg-neutral-50/80 py-1.5 px-3 rounded-md">
                                                  <span className="text-neutral-900 font-bold">AI Violation Report:</span> {item.reason}
                                              </p>
                                          </div>
                                      </div>
                                   );
                               })}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Tab 3: Outgoing link list reports */}
                      {activeTab === 'links' && (
                        <div className="space-y-4 animate-in fade-in duration-300">
                          {totalLinkIssues === 0 ? (
                            <div className="bg-emerald-50/50 border border-emerald-100 rounded-2xl p-8 text-center text-emerald-800 space-y-2">
                                <CheckCircle className="mx-auto text-emerald-500 animate-bounce" size={28} />
                                <p className="font-semibold text-sm">Outbound Links Clear</p>
                                <p className="text-xs text-emerald-600/90">No suspicious domain redirections, ad redirections, or spam targets were pointed by hyperlinks.</p>
                            </div>
                          ) : (
                            <div className="grid gap-3">
                               {selectedReport.result.linkIssues.map((item, index) => (
                                  <div key={index} className="bg-white rounded-xl p-4 sm:p-5 border border-red-100 shadow-sm flex items-start gap-4">
                                      <div className="mt-0.5 bg-red-100 text-red-600 p-1.5 rounded-lg shrink-0 border border-red-200">
                                          <ExternalLink size={16} />
                                      </div>
                                      <div className="space-y-2 min-w-0 flex-1 text-xs">
                                          <div className="flex flex-wrap items-center gap-1.5 leading-normal">
                                              <span className="font-bold text-neutral-800 bg-neutral-100 px-2 py-0.5 rounded border border-neutral-200 text-[11px]">
                                                  "{item.anchorText}"
                                              </span>
                                              <span className="text-neutral-400">→</span>
                                              <a 
                                                  href={item.url} 
                                                  target="_blank" 
                                                  rel="noreferrer" 
                                                  className="text-blue-600 hover:underline font-mono text-[11px] truncate max-w-full inline-block"
                                              >
                                                  {item.url}
                                              </a>
                                          </div>
                                          <div className="text-neutral-500 text-[11px] italic pl-2.5 border-l-2 border-neutral-200 py-0.5 bg-neutral-50/50 pr-4">
                                              Context: "{item.section}"
                                          </div>
                                          <p className="text-xs text-red-800 font-medium bg-red-50/70 py-1.5 px-3 rounded-md">
                                              <span className="font-bold">Redirect risk:</span> {item.reason}
                                          </p>
                                      </div>
                                  </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Tab 4: Semantic HTML Issue reports */}
                      {activeTab === 'semantic' && (
                        <div className="space-y-4 animate-in fade-in duration-300">
                          {totalSemanticIssues === 0 ? (
                            <div className="bg-emerald-50/50 border border-emerald-100 rounded-2xl p-8 text-center text-emerald-800 space-y-2">
                                <CheckCircle className="mx-auto text-emerald-500 animate-bounce" size={28} />
                                <p className="font-semibold text-sm">Semantic Structure is Perfect!</p>
                                <p className="text-xs text-emerald-600/90">AI detected no missing address elements or un-mapped business hour details on this page.</p>
                            </div>
                          ) : (
                            <div className="grid gap-4">
                                {selectedReport.result?.semanticIssues?.map((item, index) => {
                                   let badgeColor = "bg-purple-50 text-purple-700 border-purple-100";
                                   let label = "Semantic HTML Warning";
                                   if (item.issueType === "address_missing_address_tag") {
                                      badgeColor = "bg-rose-50 text-rose-700 border-rose-100";
                                      label = "Missing <address> Tag";
                                   } else if (item.issueType === "hours_missing_definition_list") {
                                      badgeColor = "bg-amber-50 text-amber-700 border-amber-100";
                                      label = "Missing Definition List <dl>";
                                   }

                                   return (
                                       <div key={index} className="bg-white rounded-xl p-4 sm:p-5 border border-neutral-200 shadow-sm flex flex-col items-stretch gap-4 hover:border-neutral-300 transition-colors animate-in fade-in duration-200">
                                           <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-100 pb-3">
                                               <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded border shrink-0 uppercase tracking-widest ${badgeColor} w-fit`}>
                                                   {label}
                                               </span>
                                               <span className="text-[10px] text-neutral-400 font-mono">
                                                   Issue #{index + 1}
                                               </span>
                                           </div>

                                           <div className="space-y-3">
                                               <div className="text-xs space-y-1">
                                                   <span className="font-bold text-neutral-500 uppercase tracking-wider text-[9px] block">Non-semantic Markup snippet matched:</span>
                                                   <div className="bg-neutral-50 border border-neutral-200 rounded p-3 font-mono text-[11px] text-neutral-700 whitespace-pre-wrap overflow-x-auto">
                                                       {item.elementContent}
                                                   </div>
                                               </div>

                                               <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs pt-1">
                                                   <div className="bg-red-50/50 p-3 rounded-lg border border-red-100/50 space-y-1">
                                                       <span className="font-extrabold text-red-800">Violation Reason</span>
                                                       <p className="text-neutral-700 leading-relaxed text-[11px]">
                                                           {item.reason}
                                                       </p>
                                                   </div>
                                                   <div className="bg-emerald-50/50 p-3 rounded-lg border border-emerald-100/50 space-y-1">
                                                       <span className="font-extrabold text-emerald-800">HTML Standard Remediation</span>
                                                       <p className="text-neutral-700 leading-relaxed text-[11px] font-mono whitespace-pre-wrap">
                                                           {item.recommendation}
                                                       </p>
                                                   </div>
                                               </div>
                                           </div>
                                       </div>
                                   );
                                })}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Tab 5: Image Duplicate Audit reports */}
                      {activeTab === 'images' && (
                        <div className="space-y-4 animate-in fade-in duration-300">
                          {totalImageIssues === 0 ? (
                            <div className="bg-emerald-50/50 border border-emerald-100 rounded-2xl p-8 text-center text-emerald-800 space-y-2">
                                <CheckCircle className="mx-auto text-emerald-500 animate-bounce" size={28} />
                                <p className="font-semibold text-sm">Perfect Visual Quality Control!</p>
                                <p className="text-xs text-emerald-600/90">No repetitive layout or content images were detected inside this page's custom blocks.</p>
                            </div>
                          ) : (
                            <div className="grid gap-4">
                                {selectedReport.result?.imageIssues?.map((item, index) => {
                                   let badgeColor = "bg-violet-50 text-violet-700 border-violet-100";
                                   let label = "Visual Duplication Warning";
                                   if (item.duplicationType === "same_page") {
                                      badgeColor = "bg-amber-50 text-amber-700 border-amber-100";
                                      label = "Same-Page Duplication";
                                   } else if (item.duplicationType === "cross_page") {
                                      badgeColor = "bg-purple-50 text-purple-700 border-purple-100";
                                      label = "Cross-Page Duplication";
                                   }

                                   return (
                                       <div key={index} className="bg-white rounded-xl p-4 sm:p-5 border border-neutral-200 shadow-sm flex flex-col items-stretch gap-4 hover:border-neutral-300 transition-colors animate-in fade-in duration-200">
                                           <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-100 pb-3">
                                               <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded border shrink-0 uppercase tracking-widest ${badgeColor} w-fit`}>
                                                   {label}
                                               </span>
                                               <span className="text-[10px] text-neutral-400 font-mono">
                                                   Occurrences: {item.occurrences}
                                               </span>
                                           </div>

                                           <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-start">
                                               {/* Small thumbnail preview */}
                                               <div className="relative border border-neutral-200 rounded-lg overflow-hidden bg-neutral-50 h-24 flex items-center justify-center p-1 group col-span-1">
                                                   <img 
                                                       src={item.src} 
                                                       alt={item.alt}
                                                       referrerPolicy="no-referrer"
                                                       className="max-h-full max-w-full object-contain filter drop-shadow group-hover:scale-105 transition-transform"
                                                       onError={(e) => {
                                                           (e.target as HTMLElement).style.display = 'none';
                                                       }}
                                                   />
                                                   <div className="absolute inset-0 flex items-center justify-center bg-neutral-150/10 text-[9px] text-neutral-400 pointer-events-none text-center px-1 font-sans">
                                                       Preview
                                                   </div>
                                               </div>

                                               <div className="md:col-span-3 text-xs space-y-2">
                                                   <div className="space-y-0.5">
                                                       <span className="font-bold text-neutral-500 uppercase tracking-wider text-[9px] block">Image URL Source:</span>
                                                       <a 
                                                           href={item.src} 
                                                           target="_blank" 
                                                           rel="noreferrer" 
                                                           className="text-blue-600 hover:underline font-mono text-[11px] block break-all"
                                                       >
                                                           {item.src}
                                                       </a>
                                                   </div>
                                                   <div className="space-y-0.5">
                                                       <span className="font-bold text-neutral-500 uppercase tracking-wider text-[9px] block">Alt Text:</span>
                                                       <p className="text-neutral-700 italic text-[11px]">
                                                           "{item.alt}"
                                                       </p>
                                                   </div>
                                                   {item.otherPages && item.otherPages.length > 0 && (
                                                       <div className="space-y-1 pt-1.5 border-t border-neutral-100">
                                                           <span className="font-bold text-neutral-500 uppercase tracking-wider text-[9px] block">Shared with companion page(s):</span>
                                                           <ul className="list-disc pl-4 space-y-0.5 font-mono">
                                                               {item.otherPages.map((pageUrl) => (
                                                                   <li key={pageUrl} className="text-neutral-600 text-[10px] break-all list-item">
                                                                       {getRelativePath(pageUrl)} <span className="text-neutral-400 font-sans truncate inline-block max-w-[200px] align-bottom">({pageUrl})</span>
                                                                   </li>
                                                               ))}
                                                           </ul>
                                                       </div>
                                                   )}
                                               </div>
                                           </div>

                                           <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs pt-1 border-t border-neutral-100">
                                               <div className="bg-red-50/50 p-3 rounded-lg border border-red-100/50 space-y-1">
                                                   <span className="font-extrabold text-red-800">SEO / SOP Impact</span>
                                                   <p className="text-neutral-700 leading-relaxed text-[11px]">
                                                       {item.reason}
                                                   </p>
                                               </div>
                                               <div className="bg-emerald-50/50 p-3 rounded-lg border border-emerald-100/50 space-y-1">
                                                   <span className="font-extrabold text-emerald-800">Correction Standard</span>
                                                   <p className="text-neutral-700 leading-relaxed text-[11px]">
                                                       {item.recommendation}
                                                   </p>
                                               </div>
                                           </div>
                                       </div>
                                   );
                                })}
                            </div>
                          )}
                        </div>
                      )}

                    </div>
                  )}
                </>
              ) : (
                /* Starter State when waiting for first URL to be discovered or initialized */
                <div className="bg-white rounded-2xl border border-neutral-200 p-12 text-center text-neutral-400 space-y-4 shadow-sm">
                  <Layout className="mx-auto text-neutral-300" size={56} />
                  <div className="space-y-2">
                    <h3 className="text-xl font-bold text-neutral-800">
                      Begin Crawler Audit Session
                    </h3>
                    <p className="text-sm max-w-md mx-auto text-neutral-500">
                      Submit a domain above. The auditor will inspect its XML sitemaps to build a full crawl queue, then safely complete them page by page.
                    </p>
                  </div>
                </div>
              )}

            </main>
          </div>
        )}

        {/* Starter State when no sessions are active */}
        {reports.length === 0 && !loading && !error && (
          <div className="bg-white rounded-2xl border border-neutral-200 p-12 sm:p-16 text-center text-neutral-400 space-y-6 max-w-3xl mx-auto shadow-sm">
            <Layout className="mx-auto text-neutral-300 animate-pulse" size={64} />
            <div className="space-y-3">
              <h3 className="text-2xl font-bold text-neutral-800">
                Sitemap & Heading Outline Auditor Engine
              </h3>
              <p className="text-sm sm:text-base max-w-lg mx-auto text-neutral-500 leading-relaxed">
                Provide a website URL. Our crawler parses index structures, checks hierarchy skips across H1-H6 headers, flags casing inconsistencies, and extracts potential redirect traps.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-left max-w-xl mx-auto pt-4 border-t border-neutral-100">
              <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-150/60 text-xs text-neutral-600 space-y-1">
                <span className="font-bold block text-neutral-800">1. Sitemap Search</span>
                <span>Locates standard XML files or performs emergency link mapping automatically.</span>
              </div>
              <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-150/60 text-xs text-neutral-600 space-y-1">
                <span className="font-bold block text-neutral-800">2. Page-By-Page Sequence</span>
                <span>Safe sequential scheduling with Rest windows to prevent server timeout flags.</span>
              </div>
              <div className="p-3 bg-neutral-50 rounded-xl border border-neutral-150/60 text-xs text-neutral-600 space-y-1">
                <span className="font-bold block text-neutral-800">3. Real-time Results</span>
                <span>Instantly scan completed pages while the crawler runs background tasks.</span>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
