// Shared pagination-metadata shape (Phase 10 spec) - additive only. Every
// paginated response already returns {data, page, pageSize, total} and every
// existing frontend consumer reads those flat fields directly; this adds a
// `pagination` object alongside them (never replacing) so a client can also
// derive hasNextPage/hasPreviousPage/totalPages without a breaking change to
// any of the ~15 endpoints already shipped in Phases 5-9.
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export function paginationMeta(page: number, pageSize: number, total: number): PaginationMeta {
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    page,
    limit: pageSize,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}
