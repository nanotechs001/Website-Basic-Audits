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

export interface SemanticIssue {
    elementContent: string;
    issueType: 'address_missing_address_tag' | 'hours_missing_definition_list';
    reason: string;
    recommendation: string;
}

export interface ImageIssue {
    src: string;
    alt: string;
    duplicationType: 'same_page' | 'cross_page';
    occurrences: number;
    otherPages?: string[];
    reason: string;
    recommendation: string;
}

export interface AuditResult {
    mainTopic: string;
    misplacedContent: MisplacedContent[];
    linkIssues: LinkIssue[];
    headingIssues: HeadingIssue[];
    semanticIssues: SemanticIssue[];
    imageIssues?: ImageIssue[];
    contentImages?: { src: string; alt: string; parentTag: string }[];
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

