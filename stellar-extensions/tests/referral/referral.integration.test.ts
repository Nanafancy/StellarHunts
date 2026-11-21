/**
 * Integration tests for the referral system (#984).
 *
 * The suite wires the real backend referral services together and runs the
 * complete flow — referral code generation, link attribution, registration,
 * first-puzzle reward distribution, multi-level chains, duplicate handling and
 * statistics — against in-memory repositories, so it runs in CI without a
 * database or a live API.
 */

import "reflect-metadata";

import { BadRequestException } from "@nestjs/common";

import { ReferralBonusService } from "../../../backend/src/referral/services/referral-bonus.service";
import { ReferralCodeService } from "../../../backend/src/referral/services/referral-code.service";
import { ReferralInviteService } from "../../../backend/src/referral/services/referral-invite.service";
import { ReferralService } from "../../../backend/src/referral/services/referral.service";
import { BonusStatus, BonusType } from "../../../backend/src/referral/entities/referral-bonus.entity";
import { InviteStatus } from "../../../backend/src/referral/entities/referral-invite.entity";
import { InMemoryRepository } from "./support/in-memory-repository";

const APP_URL = "https://nft-hunt.com";

/**
 * Mirrors `generateReferralLink` in `frontend/hooks/useReferral.js`.
 */
function generateReferralLink(userId: string): string {
  return `${APP_URL}/ref/${userId}`;
}

function createReferralStack() {
  const codeRepository = new InMemoryRepository<any>({
    totalInvites: 0,
    successfulInvites: 0,
    totalBonusEarned: 0,
    isActive: true,
  });
  const inviteRepository = new InMemoryRepository<any>({
    status: InviteStatus.PENDING,
  });
  const bonusRepository = new InMemoryRepository<any>({
    status: BonusStatus.PENDING,
    currency: "USD",
  });

  inviteRepository.hydrate = (invite) => {
    const code = codeRepository.rows.find(
      (candidate) => candidate.id === invite.referralCodeId,
    );
    return {
      ...invite,
      referralCode: code
        ? { ...code, user: { id: code.userId } }
        : undefined,
    };
  };
  codeRepository.hydrate = (code) => ({
    ...code,
    user: { id: code.userId },
    invites: inviteRepository.rows.filter(
      (invite) => invite.referralCodeId === code.id,
    ),
  });
  bonusRepository.hydrate = (bonus) => ({
    ...bonus,
    referralInvite:
      inviteRepository.rows.find(
        (invite) => invite.id === bonus.referralInviteId,
      ) ?? null,
  });

  const codeService = new ReferralCodeService(codeRepository as any);
  const inviteService = new ReferralInviteService(
    inviteRepository as any,
    codeService,
  );
  const bonusService = new ReferralBonusService(
    bonusRepository as any,
    codeService,
  );
  const referralService = new ReferralService(
    codeService,
    inviteService,
    bonusService,
  );

  return {
    codeService,
    inviteService,
    bonusService,
    referralService,
    codeRepository,
    inviteRepository,
    bonusRepository,
  };
}

type Stack = ReturnType<typeof createReferralStack>;

const ALICE = { id: "user-alice", email: "alice@example.com" };
const BOB = { id: "user-bob", email: "bob@example.com" };
const CAROL = { id: "user-carol", email: "carol@example.com" };

/** Register `referee` through `referrer`'s referral link. */
async function joinViaReferral(
  stack: Stack,
  referrer: { id: string },
  referee: { id: string; email: string },
) {
  const link = generateReferralLink(referrer.id);
  const referralId = link.split("/").pop() as string;

  return stack.referralService.trackReferral(
    referee.id,
    referee.email,
    { referrerId: referralId },
  );
}

describe("referral system integration", () => {
  describe("referral link and code generation", () => {
    it("creates a unique, shareable referral code per user", async () => {
      const stack = createReferralStack();

      const aliceCode = await stack.codeService.createReferralCode(ALICE.id);
      const bobCode = await stack.codeService.createReferralCode(BOB.id);

      expect(aliceCode.code).toMatch(/^[A-Z0-9]{8}$/);
      expect(bobCode.code).toMatch(/^[A-Z0-9]{8}$/);
      expect(aliceCode.code).not.toBe(bobCode.code);
      expect(aliceCode.userId).toBe(ALICE.id);
      expect(aliceCode.isActive).toBe(true);
      expect(aliceCode.totalInvites).toBe(0);
      expect(aliceCode.successfulInvites).toBe(0);
    });

    it("generates a referral link whose id can be tracked", async () => {
      const stack = createReferralStack();
      await stack.codeService.createReferralCode(ALICE.id);

      const link = generateReferralLink(ALICE.id);
      expect(link).toBe(`${APP_URL}/ref/${ALICE.id}`);

      const invitation = await stack.referralService.trackReferral(
        BOB.id,
        BOB.email,
        { referrerId: link.split("/").pop() as string },
      );

      expect(invitation.success).toBe(true);
      expect(invitation.isNew).toBe(true);
    });
  });

  describe("referral tracking on registration", () => {
    it("records the referee against the referrer's code", async () => {
      const stack = createReferralStack();
      const [aliceCode] = [
        await stack.codeService.createReferralCode(ALICE.id),
      ];

      const result = await joinViaReferral(stack, ALICE, BOB);

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(true);
      expect(result.invite.referralCodeId).toBe(aliceCode.id);
      expect(result.invite.invitedUserId).toBe(BOB.id);
      expect(result.invite.status).toBe(InviteStatus.REGISTERED);
      expect(result.invite.registeredAt).toBeInstanceOf(Date);

      const updatedCode = await stack.codeService.findByCode(aliceCode.code);
      expect(updatedCode.totalInvites).toBe(1);
    });

    it("attributes a registration to the referrer when the link uses a code", async () => {
      const stack = createReferralStack();
      const aliceCode = await stack.codeService.createReferralCode(ALICE.id);

      const result = await stack.referralService.trackReferral(
        BOB.id,
        BOB.email,
        { referrerId: aliceCode.code },
      );

      expect(result.invite.referralCodeId).toBe(aliceCode.id);
    });
  });

  describe("reward distribution on the referee's first puzzle", () => {
    it("pays the referrer and the referee exactly once", async () => {
      const stack = createReferralStack();
      const aliceCode = await stack.codeService.createReferralCode(ALICE.id);
      const tracked = await joinViaReferral(stack, ALICE, BOB);

      // Completing the invite is the backend's reward trigger once the
      // referee has solved their first puzzle.
      const allocated = await stack.referralService.processCompletedInvite(
        tracked.invite.id,
        ALICE.id,
      );

      expect(allocated).toHaveLength(2);

      const completed = await stack.inviteService.findById(tracked.invite.id);
      expect(completed.status).toBe(InviteStatus.COMPLETED);
      expect(completed.completedAt).toBeInstanceOf(Date);

      const bonuses = stack.bonusRepository.rows;
      expect(bonuses).toHaveLength(2);

      const referrerBonus = bonuses.find(
        (bonus) => bonus.type === BonusType.REFERRAL_REWARD,
      );
      const refereeBonus = bonuses.find(
        (bonus) => bonus.type === BonusType.SIGNUP_BONUS,
      );
      expect(referrerBonus).toMatchObject({
        userId: ALICE.id,
        referralInviteId: tracked.invite.id,
        amount: 10,
        status: BonusStatus.PENDING,
      });
      expect(refereeBonus).toMatchObject({
        userId: BOB.id,
        amount: 5,
        status: BonusStatus.PENDING,
      });

      const code = await stack.codeService.findByCode(aliceCode.code);
      expect(code.successfulInvites).toBe(1);
      expect(Number(code.totalBonusEarned)).toBe(15);
    });
  });

  describe("multi-level referral rewards", () => {
    it("rewards each referrer in an A -> B -> C chain", async () => {
      const stack = createReferralStack();

      await stack.codeService.createReferralCode(ALICE.id);
      const ab = await joinViaReferral(stack, ALICE, BOB);
      await stack.codeService.createReferralCode(BOB.id);
      const bc = await joinViaReferral(stack, BOB, CAROL);

      await stack.referralService.processCompletedInvite(ab.invite.id, ALICE.id);
      await stack.referralService.processCompletedInvite(bc.invite.id, BOB.id);

      const bonusesFor = (userId: string) =>
        stack.bonusRepository.rows.filter((bonus) => bonus.userId === userId);

      expect(bonusesFor(ALICE.id)).toEqual([
        expect.objectContaining({ type: BonusType.REFERRAL_REWARD, amount: 10 }),
      ]);
      expect(bonusesFor(BOB.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: BonusType.REFERRAL_REWARD, amount: 10 }),
          expect.objectContaining({ type: BonusType.SIGNUP_BONUS, amount: 5 }),
        ]),
      );
      expect(bonusesFor(CAROL.id)).toEqual([
        expect.objectContaining({ type: BonusType.SIGNUP_BONUS, amount: 5 }),
      ]);
      expect(bonusesFor(BOB.id)).toHaveLength(2);

      const bobStats = await stack.referralService.getUserReferralStats(BOB.id);
      expect(bobStats.successfulInvites).toBe(1);
      expect(bobStats.totalBonusEarned).toBe(15);
    });
  });

  describe("duplicate referral prevention", () => {
    it("rejects self-referral", async () => {
      const stack = createReferralStack();
      const aliceCode = await stack.codeService.createReferralCode(ALICE.id);

      await expect(
        stack.referralService.trackReferral(ALICE.id, ALICE.email, {
          referrerId: aliceCode.code,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stack.inviteRepository.rows).toHaveLength(0);
    });

    it("treats a repeated track as idempotent", async () => {
      const stack = createReferralStack();
      const aliceCode = await stack.codeService.createReferralCode(ALICE.id);

      const first = await joinViaReferral(stack, ALICE, BOB);
      const second = await joinViaReferral(stack, ALICE, BOB);

      expect(first.isNew).toBe(true);
      expect(second.isNew).toBe(false);
      expect(stack.inviteRepository.rows).toHaveLength(1);
      expect(
        (await stack.codeService.findByCode(aliceCode.code)).totalInvites,
      ).toBe(1);
    });

    it("does not allocate the same bonus twice", async () => {
      const stack = createReferralStack();
      await stack.codeService.createReferralCode(ALICE.id);
      const tracked = await joinViaReferral(stack, ALICE, BOB);

      await stack.referralService.processCompletedInvite(tracked.invite.id, ALICE.id);
      await stack.referralService.processCompletedInvite(tracked.invite.id, ALICE.id);

      expect(stack.bonusRepository.rows).toHaveLength(2);
      const code = stack.codeRepository.rows[0];
      expect(code.successfulInvites).toBe(1);
      expect(Number(code.totalBonusEarned)).toBe(15);
    });
  });

  describe("referral statistics query", () => {
    it("reports invite counts, conversion rate and bonus totals", async () => {
      const stack = createReferralStack();
      await stack.codeService.createReferralCode(ALICE.id);

      const bobInvite = await joinViaReferral(stack, ALICE, BOB);
      await joinViaReferral(stack, ALICE, CAROL);
      await stack.referralService.processCompletedInvite(
        bobInvite.invite.id,
        ALICE.id,
      );

      const stats = await stack.referralService.getUserReferralStats(ALICE.id);

      expect(stats).toEqual({
        totalInvites: 2,
        successfulInvites: 1,
        conversionRate: 50,
        totalBonusEarned: 15,
        // The referrer's own share is the 10 USD referral reward; the
        // referee's 5 USD signup bonus belongs to the referee.
        pendingBonuses: 10,
        processedBonuses: 0,
      });
    });

    it("moves a bonus from pending to processed when it is paid out", async () => {
      const stack = createReferralStack();
      await stack.codeService.createReferralCode(ALICE.id);
      const tracked = await joinViaReferral(stack, ALICE, BOB);
      await stack.referralService.processCompletedInvite(tracked.invite.id, ALICE.id);

      const referrerBonus = stack.bonusRepository.rows.find(
        (bonus) => bonus.userId === ALICE.id,
      );
      await stack.bonusService.processBonus(referrerBonus.id);

      const stats = await stack.referralService.getUserReferralStats(ALICE.id);
      expect(stats.pendingBonuses).toBe(0);
      expect(stats.processedBonuses).toBe(10);
    });
  });
});
