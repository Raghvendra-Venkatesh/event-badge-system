function buildParticipantListFilter(q, type, archived) {
  const params = [`%${q}%`, `%${q}%`, `%${q}%`];
  let where = `archived_at IS ${archived ? 'NOT ' : ''}NULL
    AND (COALESCE(name, '') ILIKE ? OR COALESCE(email, '') ILIKE ? OR badge_id ILIKE ?)`;

  if (type) {
    where += ' AND type = ?';
    params.push(type);
  }

  return { where, params };
}

module.exports = { buildParticipantListFilter };
