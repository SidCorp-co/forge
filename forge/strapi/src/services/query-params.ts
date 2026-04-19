/**
 * Shared query parameter parsing for Strapi document service queries.
 * Used by issue, task, and comment controllers.
 */
export function parseQueryParams(query: any): {
  filters?: any;
  sort?: any;
  limit: number;
  start: number;
  populate?: any;
  fields?: any;
} {
  const { filters, populate, sort, pagination, fields } = query;
  const params: any = {};

  if (filters) params.filters = filters;

  if (sort) {
    const [field, order] = (typeof sort === 'string' ? sort : sort[0]).split(':');
    params.sort = { [field]: order || 'asc' };
  }

  params.limit = pagination?.pageSize ? Number(pagination.pageSize) : 25;
  params.start = pagination?.page ? (Number(pagination.page) - 1) * params.limit : 0;

  if (populate === '*') {
    params.populate = '*';
  } else if (populate) {
    params.populate = populate;
  }

  if (fields) {
    params.fields = Array.isArray(fields) ? fields : [fields];
  }

  return params;
}

/** Build standard pagination meta from params and total count. */
export function paginationMeta(query: any, total: number, limit: number) {
  return {
    pagination: {
      page: query.pagination?.page ? Number(query.pagination.page) : 1,
      pageSize: limit,
      pageCount: Math.ceil(total / limit),
      total,
    },
  };
}
