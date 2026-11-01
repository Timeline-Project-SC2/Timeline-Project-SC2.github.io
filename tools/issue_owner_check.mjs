const ORGANIZATION = 'Timeline-Project-SC2';
const REPOSITORY = 'Timeline-Project-SC2/Timeline-Project-SC2.github.io';
const ORGANIZATION_ID = 343675816;
const REPOSITORY_ID = 1421259694;

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const sameName = (value, expected) =>
  typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
const validLogin = (value) =>
  typeof value === 'string' && value.length <= 39 &&
  /^[a-z\d]+(?:-[a-z\d]+)*$/i.test(value);

// Это оценка свидетельств, а не авторизация. Источник события и ответа API
// проверяется вызывающей стороной; незавершившийся callback не ограничен таймером.
export async function assessIssueOwner(eventName, event, getMembership) {
  if (eventName !== 'issues') return { status: 'ignored' };
  if (typeof event?.action !== 'string') return { status: 'indeterminate' };
  if (event.action !== 'opened') return { status: 'ignored' };

  const repoName = event.repository?.full_name;
  if (typeof repoName === 'string' && /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repoName) &&
      !sameName(repoName, REPOSITORY)) {
    return { status: 'ignored' };
  }

  const repository = event.repository;
  const organization = event.organization;
  const issue = event.issue;
  const author = issue?.user;
  const sender = event.sender;
  if (!sameName(repoName, REPOSITORY) || repository?.id !== REPOSITORY_ID ||
      repository?.owner?.id !== ORGANIZATION_ID ||
      repository?.owner?.type !== 'Organization' ||
      !sameName(repository?.owner?.login, ORGANIZATION) ||
      organization?.id !== ORGANIZATION_ID || !sameName(organization?.login, ORGANIZATION) ||
      !validId(issue?.id) || !validId(issue?.number) || issue?.state !== 'open' ||
      author?.type !== 'User' || sender?.type !== 'User' ||
      !validId(author?.id) || !validId(sender?.id) || author.id !== sender.id ||
      !validLogin(author?.login) || typeof getMembership !== 'function') {
    return { status: 'indeterminate' };
  }

  try {
    const membership = await getMembership(ORGANIZATION, author.login);
    if (!membership || typeof membership !== 'object' ||
        ('status' in membership && membership.status !== 200) ||
        !validId(membership.user?.id) || membership.user.id !== author.id ||
        membership.organization?.id !== ORGANIZATION_ID ||
        !['active', 'pending'].includes(membership.state) ||
        !['admin', 'member'].includes(membership.role)) {
      return { status: 'indeterminate' };
    }
    return { status: membership.state === 'active' && membership.role === 'admin'
      ? 'owner_role_evidence' : 'not_owner' };
  } catch {
    return { status: 'indeterminate' };
  }
}
