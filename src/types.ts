export interface MisplacedContent {
    excerpt: string;
    reason: string;
}

export interface LinkIssue {
    anchorText: string;
    url: string;
    section: string;
    reason: string;
}

export interface HeadingIssue {
    headingText: string;
    tag: string;
    issueType: 'structure_skip' | 'multiple_h1' | 'capitalization' | 'mismatched_content' | 'other';
    context?: string;
    reason: string;
}

export interface AuditResult {
    mainTopic: string;
    misplacedContent: MisplacedContent[];
    linkIssues: LinkIssue[];
    headingIssues: HeadingIssue[];
}

export interface AuditError {
    error: string;
}

export interface PageAuditReport {
    url: string;
    result: AuditResult | null;
    error: string | null;
    status: 'pending' | 'scanning' | 'completed' | 'failed';
}

