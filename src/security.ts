export class QueryValidator {
  private static readonly ALLOWED_STATEMENTS = [
    'SELECT',
    'WITH',
    'SHOW',
    'DESCRIBE',
    'EXPLAIN',
  ];

  private static readonly FORBIDDEN_KEYWORDS = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'CREATE',
    'ALTER',
    'TRUNCATE',
    'EXEC',
    'EXECUTE',
    'OPENROWSET',
    'OPENDATASOURCE',
    'BULK',
    'MERGE',
    'GRANT',
    'REVOKE',
    'DENY',
  ];

  private static readonly FORBIDDEN_PREFIXES = [
    'SP_',
    'XP_',
  ];

  static validateQuery(query: string): { isValid: boolean; error?: string } {
    const normalizedQuery = query.trim().toUpperCase();

    if (!normalizedQuery) {
      return { isValid: false, error: 'Empty query not allowed' };
    }

    // Check if query starts with allowed statement
    const startsWithAllowed = this.ALLOWED_STATEMENTS.some(stmt =>
      normalizedQuery.startsWith(stmt)
    );

    if (!startsWithAllowed) {
      return {
        isValid: false,
        error: `Query must start with one of: ${this.ALLOWED_STATEMENTS.join(', ')}`
      };
    }

    // Check for forbidden keywords (whole-word match to avoid false positives like create_date)
    for (const forbidden of this.FORBIDDEN_KEYWORDS) {
      const pattern = new RegExp(`\\b${forbidden}\\b`);
      if (pattern.test(normalizedQuery)) {
        return {
          isValid: false,
          error: `Forbidden keyword detected: ${forbidden}`
        };
      }
    }

    // Check for forbidden prefixes (SP_, XP_)
    for (const prefix of this.FORBIDDEN_PREFIXES) {
      if (normalizedQuery.includes(prefix)) {
        return {
          isValid: false,
          error: `Forbidden keyword detected: ${prefix}`
        };
      }
    }

    // Additional security checks
    if (this.containsSqlInjectionPatterns(normalizedQuery)) {
      return { 
        isValid: false, 
        error: 'Potential SQL injection pattern detected' 
      };
    }

    return { isValid: true };
  }

  private static containsSqlInjectionPatterns(query: string): boolean {
    const patterns = [
      /--/,  // SQL comments
      /\/\*/,  // Multi-line comments
      /;.*SELECT/,  // Statement injection
      /'\s*OR\s*'.*'/,  // OR injection
      /'\s*AND\s*'.*'/,  // AND injection
    ];

    return patterns.some(pattern => pattern.test(query));
  }

  static sanitizeQuery(query: string): string {
    return query
      .trim()
      .replace(/\s+/g, ' ')  // Normalize whitespace
      .replace(/;$/, '');    // Remove trailing semicolon
  }

  static addRowLimit(query: string, maxRows: number): string {
    const normalizedQuery = query.trim().toUpperCase();

    // If query already has TOP clause, don't modify
    if (normalizedQuery.includes('TOP ')) {
      return query;
    }

    // TOP on the first SELECT of a UNION only limits that branch, so wrap
    // the whole union in a derived table instead. The final ORDER BY of a
    // union may only reference output columns, so it can be hoisted outside
    // the wrapper (T-SQL forbids it inside a derived table).
    if (this.findTopLevelKeyword(query, /UNION\b/iy).length > 0) {
      const orderByPositions = this.findTopLevelKeyword(query, /ORDER\s+BY\b/iy);
      const orderByStart = orderByPositions.length > 0
        ? orderByPositions[orderByPositions.length - 1]!
        : query.length;
      const body = query.slice(0, orderByStart).trim();
      const orderBy = query.slice(orderByStart).trim();
      return `SELECT TOP ${maxRows} * FROM (${body}) AS [__sqlq_limit]${orderBy ? ` ${orderBy}` : ''}`;
    }

    // Add TOP clause after SELECT
    return query.replace(
      /^(\s*SELECT\s+)/i,
      `$1TOP ${maxRows} `
    );
  }

  /**
   * Returns positions where the sticky pattern matches at paren depth 0,
   * outside string literals ('...') and bracketed identifiers ([...]).
   */
  private static findTopLevelKeyword(query: string, pattern: RegExp): number[] {
    const positions: number[] = [];
    let depth = 0;
    let i = 0;
    while (i < query.length) {
      const ch = query[i];
      if (ch === "'") {
        i++;
        while (i < query.length) {
          if (query[i] === "'") {
            if (query[i + 1] === "'") { i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (ch === '[') {
        const close = query.indexOf(']', i);
        if (close === -1) break;
        i = close + 1;
        continue;
      }
      if (ch === '(') { depth++; i++; continue; }
      if (ch === ')') { depth--; i++; continue; }
      if (depth === 0 && (i === 0 || !/\w/.test(query[i - 1]!))) {
        pattern.lastIndex = i;
        if (pattern.test(query)) {
          positions.push(i);
        }
      }
      i++;
    }
    return positions;
  }
}