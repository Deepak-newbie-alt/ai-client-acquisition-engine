import { Router } from "express";
import { z } from "zod";
import type { ScoringConfig } from "../../config/scoring.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { PageFetcherFactory } from "../../integrations/web/types.js";
import type { Db } from "../../lib/db.js";
import { isValidEmail, normalizeEmail } from "../../lib/email.js";
import { AppError, notFound } from "../../lib/errors.js";
import { FetchError } from "../../lib/safe-fetch.js";
import { canonicalizeUrl } from "../../lib/url.js";
import { parseId, safeMultilineText, safeText } from "../../lib/validation.js";
import { requireUser } from "../../middleware/auth.js";
import { recordAudit, type Actor } from "../audit/audit.js";
import { suppressionMatcher } from "../contacts/suppression.js";
import { refreshOpportunities } from "../opportunities/service.js";
import { extractPageText } from "../sources/extract.js";

const publicUrl = z
  .string()
  .max(2048)
  .transform((u, ctx) => {
    const c = canonicalizeUrl(u);
    if (!c.ok) {
      ctx.addIssue({ code: "custom", message: `URL rejected: ${c.reason}` });
      return z.NEVER;
    }
    return c.value;
  });

const createCompanySchema = z
  .strictObject({
    name: safeText(1, 200),
    website: publicUrl.optional(),
    fromSourceId: z.uuid().optional(),
  })
  .refine((v) => v.website || v.fromSourceId, "website or fromSourceId is required");

const profileSchema = z.strictObject({
  summary: safeMultilineText(0, 2_000).optional(),
  notes: safeMultilineText(0, 4_000).optional(),
});

const updateCompanySchema = z
  .strictObject({
    name: safeText(1, 200),
    researchStatus: z.enum(["DISCOVERED", "RESEARCHING", "RESEARCHED", "EXCLUDED"]),
    profile: profileSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "at least one field is required");

const createContactSchema = z.strictObject({
  email: z
    .string()
    .max(254)
    .transform(normalizeEmail)
    .refine(isValidEmail, "must be a valid email address"),
  name: safeText(1, 200).optional(),
  role: safeText(1, 200).optional(),
  // Where the address is publicly listed. Contacts without a source are not accepted.
  sourceUrl: publicUrl,
});

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export function companiesRouter(deps: { db: Db; scoring: ScoringConfig }): Router {
  const { db } = deps;
  const router = Router();
  router.use(requireUser());

  router.get("/", async (_req, res) => {
    const companies = await db.company.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { _count: { select: { contacts: true, sources: true } } },
    });
    res.json({ companies });
  });

  router.post("/", async (req, res) => {
    const input = createCompanySchema.parse(req.body);
    let domain = input.website?.registrableDomain;
    let provenanceSourceId: string | null = null;
    if (input.fromSourceId) {
      const source = await db.sourceDocument.findUnique({ where: { id: input.fromSourceId } });
      if (!source) throw notFound("Source");
      domain ??= source.registrableDomain;
      provenanceSourceId = source.id;
    }

    const company = await db
      .$transaction(async (tx) => {
        const created = await tx.company.create({
          data: { name: input.name, website: input.website?.canonicalUrl ?? null, domain: domain!, provenanceSourceId },
        });
        // Pages on the company's own domain are attributed to it, so they count
        // as one business when judging independence.
        await tx.sourceDocument.updateMany({ where: { registrableDomain: created.domain, companyId: null }, data: { companyId: created.id } });
        await recordAudit(tx, {
          actor: req.actor as Actor,
          action: "company.created",
          entityType: "Company",
          entityId: created.id,
          metadata: { domain: created.domain },
        });
        return created;
      })
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError(409, "DUPLICATE", "A company with this domain already exists");
        throw err;
      });
    await refreshOpportunities(db, deps.scoring);
    res.status(201).json({ company });
  });

  router.get("/:id", async (req, res) => {
    const company = await db.company.findUnique({
      where: { id: parseId(req.params) },
      include: {
        contacts: { orderBy: { createdAt: "asc" } },
        sources: {
          select: { id: true, canonicalUrl: true, title: true, retrievalStatus: true, _count: { select: { evidence: true } } },
          take: 100,
        },
        provenanceSource: { select: { id: true, canonicalUrl: true } },
      },
    });
    if (!company) throw notFound("Company");
    const suppressed = suppressionMatcher(await db.suppressionRecord.findMany({ select: { scope: true, value: true } }));
    const { contacts, ...rest } = company;
    res.json({ company: rest, contacts: contacts.map((c) => ({ ...c, suppressed: suppressed(c.emailNormalized) })) });
  });

  router.patch("/:id", async (req, res) => {
    const id = parseId(req.params);
    const data = updateCompanySchema.parse(req.body);
    const updated = await db.company.updateMany({ where: { id }, data });
    if (updated.count === 0) throw notFound("Company");
    await recordAudit(db, {
      actor: req.actor as Actor,
      action: "company.updated",
      entityType: "Company",
      entityId: id,
      metadata: { fields: Object.keys(data).join(",") },
    });
    res.json({ company: await db.company.findUniqueOrThrow({ where: { id } }) });
  });

  router.post("/:id/contacts", async (req, res) => {
    const companyId = parseId(req.params);
    const input = createContactSchema.parse(req.body);
    if (!(await db.company.count({ where: { id: companyId } }))) throw notFound("Company");
    const contact = await db.contact
      .create({
        data: {
          companyId,
          email: input.email,
          emailNormalized: input.email,
          name: input.name ?? null,
          role: input.role ?? null,
          sourceUrl: input.sourceUrl.canonicalUrl,
          retrievedAt: new Date(),
        },
      })
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError(409, "DUPLICATE", "This contact already exists for the company");
        throw err;
      });
    await recordAudit(db, { actor: req.actor as Actor, action: "contact.created", entityType: "Contact", entityId: contact.id, metadata: { companyId } });
    await refreshOpportunities(db, deps.scoring);
    res.status(201).json({ contact });
  });

  return router;
}

export function contactsRouter(deps: { db: Db; scoring: ScoringConfig; pages: PageFetcherFactory }): Router {
  const { db } = deps;
  const router = Router();
  router.use(requireUser());

  /**
   * Re-fetches the contact's source page (robots.txt and SSRF rules apply) and
   * marks the contact VERIFIED only if the address actually appears there.
   */
  router.post("/:id/verify", async (req, res) => {
    const id = parseId(req.params);
    const contact = await db.contact.findUnique({ where: { id } });
    if (!contact) throw notFound("Contact");

    const pages = deps.pages();
    if (!(await pages.isAllowedByRobots(contact.sourceUrl))) {
      throw new AppError(422, "VERIFY_BLOCKED", "The source page disallows automated access (robots.txt)");
    }
    let html: string;
    try {
      html = (await pages.fetchHtml(contact.sourceUrl)).html;
    } catch (err) {
      const code = err instanceof FetchError ? err.code : "NETWORK";
      throw new AppError(502, "VERIFY_FETCH_FAILED", `Could not retrieve the source page (${code})`);
    }

    const page = `${extractPageText(html, 200_000).text}\n${html}`.toLowerCase();
    const found = page.includes(contact.emailNormalized);
    const updated = await db.contact.update({
      where: { id },
      data: { verificationStatus: found ? "VERIFIED" : "INVALID", retrievedAt: new Date() },
    });
    await recordAudit(db, {
      actor: req.actor as Actor,
      action: found ? "contact.verified" : "contact.verification_failed",
      entityType: "Contact",
      entityId: id,
    });
    await refreshOpportunities(db, deps.scoring);
    res.json({ contact: updated });
  });

  router.delete("/:id", async (req, res) => {
    const id = parseId(req.params);
    if (await db.outreachDraft.count({ where: { contactId: id } })) {
      throw new AppError(409, "HAS_OUTREACH", "Contacts with outreach history cannot be deleted; suppress them instead");
    }
    const deleted = await db.contact.deleteMany({ where: { id } });
    if (deleted.count === 0) throw notFound("Contact");
    await recordAudit(db, { actor: req.actor as Actor, action: "contact.deleted", entityType: "Contact", entityId: id });
    await refreshOpportunities(db, deps.scoring);
    res.status(204).end();
  });

  return router;
}
