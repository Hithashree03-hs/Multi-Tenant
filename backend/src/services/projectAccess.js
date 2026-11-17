async function loadProjectAccess(prisma, user, projectId) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId: user.organizationId },
    select: { id: true, organizationId: true, ownerId: true, status: true, startsAt: true, dueAt: true },
  });
  if (!project) return null;

  const isAdmin = user.role === "ADMIN";
  const isOwner = project.ownerId === user.id;
  let isMember = isAdmin || isOwner;
  if (!isMember) {
    const membership = await prisma.projectMember.findFirst({
      where: { projectId: project.id, organizationId: user.organizationId, userId: user.id },
      select: { id: true },
    });
    isMember = Boolean(membership);
  }
  if (!isMember) return null;
  return { project, isAdmin, isOwner, isMember };
}

function canManageProject(access) {
  return Boolean(access && (access.isAdmin || access.isOwner));
}

module.exports = { loadProjectAccess, canManageProject };
