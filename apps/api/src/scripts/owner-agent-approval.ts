/** Explicit owner operation. Never runs during deployment or API startup. */
import { credentialDb } from '../agents/credential-database.js';
import { prisma } from '@socialplay/database';
import { approveExistingMemberAgent } from '../agents/admin-account-service.js';
import { z } from 'zod';
const [mode, adminId, adminEmail, memberId, memberEmail, countryCode] = process.argv.slice(2);
try {
  if (
    !['--verify', '--apply'].includes(mode) ||
    process.argv.length !== 8 ||
    !z.string().uuid().safeParse(adminId).success ||
    !z.string().uuid().safeParse(memberId).success ||
    !z.string().email().safeParse(adminEmail).success ||
    !z.string().email().safeParse(memberEmail).success ||
    !/^[A-Z]{2,3}$/.test(countryCode)
  )
    throw Error('Exact administrator, member and country identifiers required.');
  const target = await credentialDb.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [owner] = await tx.$queryRaw<
      Array<{ allowed: boolean }>
    >`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database() AND r.rolname=current_user) AS allowed`;
    if (!owner?.allowed) throw Error('Database owner authorization required.');
    const admin = await tx.user.findUnique({
      where: { id: adminId },
      select: { email: true, role: true, status: true },
    });
    const member = await tx.user.findUnique({
      where: { id: memberId },
      select: {
        email: true,
        role: true,
        status: true,
        username: true,
        displayName: true,
        agentProfile: { select: { id: true, status: true, countryId: true } },
      },
    });
    const country = await tx.country.findUnique({
      where: { code: countryCode },
      select: { id: true, isActive: true, currencyCode: true },
    });
    if (
      !admin ||
      admin.email !== adminEmail ||
      admin.status !== 'ACTIVE' ||
      !['ADMIN', 'SUPER_ADMIN'].includes(admin.role) ||
      !member ||
      member.email !== memberEmail ||
      member.role !== 'USER' ||
      member.status !== 'ACTIVE' ||
      adminId === memberId ||
      !country?.isActive ||
      country.currencyCode !== 'ETB'
    )
      throw Error('Account or country verification failed.');
    if (
      member.agentProfile &&
      (member.agentProfile.status !== 'ACTIVE' || member.agentProfile.countryId !== country.id)
    )
      throw Error('Existing agent must be reviewed in the workspace.');
    return { member, country };
  });
  if (target.member.agentProfile) {
    console.log(
      JSON.stringify({
        status: 'AGENT_VERIFIED',
        userId: memberId,
        email: memberEmail,
        agentId: target.member.agentProfile.id,
      })
    );
  } else if (mode === '--verify') {
    console.log(
      JSON.stringify({
        status: 'READY_TO_APPROVE',
        userId: memberId,
        email: memberEmail,
        countryCode,
      })
    );
  } else {
    console.log(
      JSON.stringify(
        // Explicit owner client: this CLI already verified it runs as the database owner.
        await approveExistingMemberAgent(
          credentialDb,
          adminId,
          {
            email: memberEmail,
            displayName: target.member.displayName || target.member.username,
            countryId: target.country.id,
          },
          memberId
        )
      )
    );
  }
} catch {
  console.error('OWNER_AGENT_APPROVAL_REFUSED_OR_NOT_CONFIRMED');
  process.exitCode = 1;
} finally {
  await credentialDb.$disconnect();
  await prisma.$disconnect();
}
