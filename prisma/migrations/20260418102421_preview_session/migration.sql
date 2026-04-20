-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provisioningId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "country" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Etc/UTC',
    "adminName" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "adminPhone" TEXT,
    "clientGithubUsername" TEXT,
    "clientGithubPermission" TEXT NOT NULL DEFAULT 'push',
    "teamGithubUsernames" TEXT,
    "brandPrimaryColor" TEXT NOT NULL,
    "brandSecondaryColor" TEXT,
    "brandLogoUrl" TEXT,
    "brandFaviconUrl" TEXT,
    "enabledModules" TEXT NOT NULL,
    "planTier" TEXT NOT NULL DEFAULT 'starter',
    "userSeats" INTEGER NOT NULL DEFAULT 5,
    "goLiveDate" DATETIME,
    "notes" TEXT,
    "githubRepoUrl" TEXT,
    "githubRepoId" TEXT,
    "commitSha" TEXT,
    "previewSessionId" TEXT,
    "previewStartedAt" DATETIME,
    "previewStoppedAt" DATETIME,
    "status" TEXT NOT NULL,
    "failureStep" TEXT,
    "friendlyError" TEXT,
    "warnings" TEXT,
    "referenceId" TEXT,
    "provisionedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProvisioningStepLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "truncatedLog" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "ProvisioningStepLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorLogin" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetSlug" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_provisioningId_key" ON "Client"("provisioningId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_slug_key" ON "Client"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Client_previewSessionId_key" ON "Client"("previewSessionId");

-- CreateIndex
CREATE INDEX "ProvisioningStepLog_clientId_idx" ON "ProvisioningStepLog"("clientId");

-- CreateIndex
CREATE INDEX "AuditLog_targetSlug_idx" ON "AuditLog"("targetSlug");

-- CreateIndex
CREATE INDEX "AuditLog_actorLogin_idx" ON "AuditLog"("actorLogin");
