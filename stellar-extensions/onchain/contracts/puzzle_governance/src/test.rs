#![cfg(test)]

use crate::{Error, ProposalStatus, PuzzleGovernance, PuzzleGovernanceClient, VoteKind};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{contract, contractimpl, Address, Env, Error as SdkError, String};

// ---------------------------------------------------------------------
// Minimal SEP-41-compatible token used to weight votes in tests.
// ---------------------------------------------------------------------

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let current: i128 = env.storage().persistent().get(&to).unwrap_or(0);
        env.storage().persistent().set(&to, &(current + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&id).unwrap_or(0)
    }
}

/// Assert that a `try_*` client call failed with `expected`.
fn assert_contract_error<T>(
    result: Result<
        Result<T, <T as soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>::Error>,
        Result<SdkError, soroban_sdk::InvokeError>,
    >,
    expected: Error,
) where
    T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val> + core::fmt::Debug,
    <T as soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>::Error: core::fmt::Debug,
{
    match result {
        Err(Ok(err)) => assert_eq!(
            err,
            SdkError::from_contract_error(expected as u32),
            "unexpected contract error",
        ),
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------

struct Fixture {
    env: Env,
    contract_id: Address,
    token_id: Address,
    admin: Address,
    alice: Address,
    bob: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(100);

    let admin = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let token_id = env.register(MockToken, ());
    let contract_id = env.register(PuzzleGovernance, ());

    // 500 quorum, 50-ledger default voting window.
    PuzzleGovernanceClient::new(&env, &contract_id).init(&admin, &token_id, &50u32, &500i128);

    Fixture {
        env,
        contract_id,
        token_id,
        admin,
        alice,
        bob,
    }
}

fn title(env: &Env) -> String {
    String::from_str(env, "Rebalance the Nebula puzzle")
}

fn description(env: &Env) -> String {
    String::from_str(env, "Lower the answer difficulty and refresh the reward tier.")
}

impl Fixture {
    fn gov(&self) -> PuzzleGovernanceClient<'_> {
        PuzzleGovernanceClient::new(&self.env, &self.contract_id)
    }

    fn token(&self) -> MockTokenClient<'_> {
        MockTokenClient::new(&self.env, &self.token_id)
    }

    fn propose(&self) -> u64 {
        self.gov().propose(
            &self.alice,
            &7u64,
            &title(&self.env),
            &description(&self.env),
            &None,
        )
    }

    fn propose_with_period(&self, period: u32) -> u64 {
        self.gov().propose(
            &self.alice,
            &7u64,
            &title(&self.env),
            &description(&self.env),
            &Some(period),
        )
    }

    fn vote_for(&self, voter: &Address, proposal_id: u64) {
        self.gov().vote(voter, &proposal_id, &VoteKind::For);
    }

    fn advance_to(&self, ledger: u32) {
        self.env.ledger().set_sequence_number(ledger);
    }
}

// ---------------------------------------------------------------------
// Initialization and configuration
// ---------------------------------------------------------------------

#[test]
fn init_stores_configuration() {
    let f = setup();
    let config = f.gov().get_config();

    assert_eq!(config.admin, f.admin);
    assert_eq!(config.token, f.token_id);
    assert_eq!(config.default_voting_period, 50);
    assert_eq!(config.quorum, 500);
    assert_eq!(f.gov().get_proposal_count(), 0);
}

#[test]
fn init_twice_is_rejected() {
    let f = setup();
    assert_contract_error(
        f.gov()
            .try_init(&f.admin, &f.token_id, &50u32, &500i128),
        Error::AlreadyInitialized,
    );
}

#[test]
fn init_rejects_zero_duration_and_negative_quorum() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register(MockToken, ());
    let contract_id = env.register(PuzzleGovernance, ());
    let client = PuzzleGovernanceClient::new(&env, &contract_id);

    assert_contract_error(
        client.try_init(&admin, &token_id, &0u32, &0i128),
        Error::InvalidDuration,
    );
    assert_contract_error(
        client.try_init(&admin, &token_id, &10u32, &-1i128),
        Error::InvalidQuorum,
    );
}

#[test]
fn admin_can_update_quorum_and_duration() {
    let f = setup();

    f.gov().set_quorum(&f.admin, &1_000i128);
    f.gov().set_default_voting_period(&f.admin, &120u32);

    let config = f.gov().get_config();
    assert_eq!(config.quorum, 1_000);
    assert_eq!(config.default_voting_period, 120);
}

#[test]
fn non_admin_cannot_update_governance_parameters() {
    let f = setup();

    assert_contract_error(f.gov().try_set_quorum(&f.alice, &1i128), Error::NotAuthorized);
    assert_contract_error(
        f.gov().try_set_default_voting_period(&f.alice, &5u32),
        Error::NotAuthorized,
    );
}

#[test]
fn settings_reject_invalid_values() {
    let f = setup();

    assert_contract_error(
        f.gov().try_set_quorum(&f.admin, &-5i128),
        Error::InvalidQuorum,
    );
    assert_contract_error(
        f.gov().try_set_default_voting_period(&f.admin, &0u32),
        Error::InvalidDuration,
    );
}

// ---------------------------------------------------------------------
// Proposal creation
// ---------------------------------------------------------------------

#[test]
fn propose_uses_the_default_voting_period() {
    let f = setup();
    let id = f.propose();

    let proposal = f.gov().get_proposal(&id);
    assert_eq!(id, 0);
    assert_eq!(proposal.proposer, f.alice);
    assert_eq!(proposal.puzzle_id, 7);
    assert_eq!(proposal.start_ledger, 100);
    assert_eq!(proposal.end_ledger, 150);
    assert_eq!(proposal.status, ProposalStatus::Active);
    assert_eq!(f.gov().get_proposal_count(), 1);
}

#[test]
fn propose_accepts_a_per_proposal_duration() {
    let f = setup();
    let id = f.propose_with_period(10);

    assert_eq!(f.gov().get_proposal(&id).end_ledger, 110);
}

#[test]
fn propose_rejects_invalid_metadata() {
    let f = setup();

    let empty = String::from_str(&f.env, "");
    assert_contract_error(
        f.gov().try_propose(
            &f.alice,
            &1u64,
            &empty,
            &description(&f.env),
            &None,
        ),
        Error::InvalidTitle,
    );

    assert_contract_error(
        f.gov().try_propose(
            &f.alice,
            &1u64,
            &title(&f.env),
            &description(&f.env),
            &Some(0u32),
        ),
        Error::InvalidDuration,
    );
}

#[test]
fn proposals_get_monotonically_increasing_ids() {
    let f = setup();
    let first = f.propose();
    let second = f.propose();

    assert_eq!(first, 0);
    assert_eq!(second, 1);
    assert_eq!(f.gov().get_proposal_count(), 2);
}

#[test]
fn unknown_proposal_is_rejected() {
    let f = setup();
    assert_contract_error(f.gov().try_get_proposal(&42u64), Error::ProposalNotFound);
}

// ---------------------------------------------------------------------
// Token-weighted voting
// ---------------------------------------------------------------------

#[test]
fn votes_are_weighted_by_token_balance() {
    let f = setup();
    let id = f.propose();

    f.token().mint(&f.alice, &900i128);
    f.token().mint(&f.bob, &300i128);

    f.vote_for(&f.alice, id);
    f.gov().vote(&f.bob, &id, &VoteKind::Against);

    let proposal = f.gov().get_proposal(&id);
    assert_eq!(proposal.for_votes, 900);
    assert_eq!(proposal.against_votes, 300);
    assert!(f.gov().has_voted(&id, &f.alice));
    assert_eq!(
        f.gov().get_vote(&id, &f.alice),
        Some((VoteKind::For, 900i128))
    );
    assert!(f.gov().has_voted(&id, &f.bob));
}

#[test]
fn voting_power_tracks_token_balances() {
    let f = setup();
    f.token().mint(&f.alice, &100i128);
    f.token().mint(&f.bob, &40i128);

    assert_eq!(f.gov().get_voting_power(&f.alice), 100);
    assert_eq!(f.gov().get_voting_power(&f.bob), 40);
}

#[test]
fn a_voter_cannot_vote_twice() {
    let f = setup();
    let id = f.propose();
    f.token().mint(&f.alice, &900i128);

    f.vote_for(&f.alice, id);
    assert_contract_error(
        f.gov().try_vote(&f.alice, &id, &VoteKind::Against),
        Error::AlreadyVoted,
    );
}

#[test]
fn accounts_without_tokens_cannot_vote() {
    let f = setup();
    let id = f.propose();

    assert_contract_error(
        f.gov().try_vote(&f.alice, &id, &VoteKind::For),
        Error::NoVotingPower,
    );
}

#[test]
fn voting_after_the_window_is_rejected() {
    let f = setup();
    let id = f.propose();
    f.token().mint(&f.alice, &900i128);

    f.advance_to(151);
    assert_contract_error(
        f.gov().try_vote(&f.alice, &id, &VoteKind::For),
        Error::VotingClosed,
    );
}

// ---------------------------------------------------------------------
// Finalization, quorum and execution
// ---------------------------------------------------------------------

#[test]
fn proposal_succeeds_with_quorum_and_a_majority() {
    let f = setup();
    let id = f.propose();
    f.token().mint(&f.alice, &600i128);
    f.token().mint(&f.bob, &200i128);
    f.vote_for(&f.alice, id);
    f.gov().vote(&f.bob, &id, &VoteKind::Against);

    f.advance_to(151);
    assert_eq!(f.gov().finalize(&id), ProposalStatus::Succeeded);
    // Finalizing again is a no-op that returns the stored outcome.
    assert_eq!(f.gov().finalize(&id), ProposalStatus::Succeeded);
}

#[test]
fn proposal_fails_without_quorum_even_if_unanimous() {
    let f = setup();
    let id = f.propose();
    f.token().mint(&f.alice, &499i128);
    f.vote_for(&f.alice, id);

    f.advance_to(151);
    assert_eq!(f.gov().finalize(&id), ProposalStatus::Defeated);
}

#[test]
fn proposal_fails_without_a_strict_majority() {
    let f = setup();
    let id = f.propose();
    f.token().mint(&f.alice, &500i128);
    f.token().mint(&f.bob, &500i128);
    f.vote_for(&f.alice, id);
    f.gov().vote(&f.bob, &id, &VoteKind::Against);

    f.advance_to(151);
    assert_eq!(f.gov().finalize(&id), ProposalStatus::Defeated);
}

#[test]
fn finalize_before_the_window_closes_is_rejected() {
    let f = setup();
    let id = f.propose();

    assert_contract_error(f.gov().try_finalize(&id), Error::VotingStillOpen);
}

#[test]
fn only_succeeded_proposals_can_be_executed() {
    let f = setup();
    let id = f.propose();
    f.token().mint(&f.alice, &600i128);
    f.vote_for(&f.alice, id);

    // Still active.
    assert_contract_error(
        f.gov().try_execute(&f.bob, &id),
        Error::VotingStillOpen,
    );

    // Cancelling a succeeded proposal leaves it non-executable.
    f.advance_to(151);
    f.gov().finalize(&id);
    f.gov().cancel(&f.alice, &id);
    assert_contract_error(
        f.gov().try_execute(&f.bob, &id),
        Error::ProposalNotSucceeded,
    );
}

#[test]
fn succeeded_proposal_can_be_executed_once() {
    let f = setup();
    let id = f.propose();
    f.token().mint(&f.alice, &600i128);
    f.vote_for(&f.alice, id);

    f.advance_to(151);
    f.gov().finalize(&id);
    f.gov().execute(&f.bob, &id);

    let proposal = f.gov().get_proposal(&id);
    assert_eq!(proposal.status, ProposalStatus::Executed);
    assert_contract_error(
        f.gov().try_execute(&f.bob, &id),
        Error::ProposalNotSucceeded,
    );
}

// ---------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------

#[test]
fn proposer_can_cancel_an_active_proposal() {
    let f = setup();
    let id = f.propose();

    f.gov().cancel(&f.alice, &id);

    assert_eq!(f.gov().get_proposal(&id).status, ProposalStatus::Cancelled);
    f.token().mint(&f.alice, &900i128);
    assert_contract_error(
        f.gov().try_vote(&f.alice, &id, &VoteKind::For),
        Error::ProposalNotActive,
    );
}

#[test]
fn admin_can_cancel_but_third_parties_cannot() {
    let f = setup();
    let id = f.propose();

    assert_contract_error(f.gov().try_cancel(&f.bob, &id), Error::NotAuthorized);

    f.gov().cancel(&f.admin, &id);
    assert_eq!(f.gov().get_proposal(&id).status, ProposalStatus::Cancelled);
}

#[test]
fn cancelled_proposals_cannot_be_cancelled_twice() {
    let f = setup();
    let id = f.propose();

    f.gov().cancel(&f.alice, &id);
    assert_contract_error(
        f.gov().try_cancel(&f.alice, &id),
        Error::ProposalNotActive,
    );
}

// ---------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------

#[test]
fn delegation_moves_voting_power_to_the_delegate() {
    let f = setup();
    f.token().mint(&f.alice, &100i128);
    f.token().mint(&f.bob, &40i128);

    f.gov().delegate(&f.alice, &f.bob);

    assert_eq!(f.gov().get_delegation(&f.alice), Some(f.bob.clone()));
    assert_eq!(f.gov().get_voting_power(&f.alice), 0);
    assert_eq!(f.gov().get_voting_power(&f.bob), 140);
}

#[test]
fn delegate_casts_combined_weight_for_both_accounts() {
    let f = setup();
    let id = f.propose();
    f.token().mint(&f.alice, &400i128);
    f.token().mint(&f.bob, &200i128);
    f.gov().delegate(&f.alice, &f.bob);

    f.vote_for(&f.bob, id);

    assert_eq!(f.gov().get_proposal(&id).for_votes, 600);
}

#[test]
fn a_delegator_cannot_vote_directly() {
    let f = setup();
    let id = f.propose();
    f.token().mint(&f.alice, &100i128);
    f.token().mint(&f.bob, &100i128);
    f.gov().delegate(&f.alice, &f.bob);

    assert_contract_error(
        f.gov().try_vote(&f.alice, &id, &VoteKind::For),
        Error::AlreadyDelegated,
    );
}

#[test]
fn undelegate_returns_power_to_the_delegator() {
    let f = setup();
    f.token().mint(&f.alice, &100i128);
    f.token().mint(&f.bob, &40i128);
    f.gov().delegate(&f.alice, &f.bob);

    f.gov().undelegate(&f.alice);

    assert_eq!(f.gov().get_delegation(&f.alice), None);
    assert_eq!(f.gov().get_voting_power(&f.alice), 100);
    assert_eq!(f.gov().get_voting_power(&f.bob), 40);
}

#[test]
fn redelegating_moves_power_to_the_new_delegate() {
    let f = setup();
    let carol = Address::generate(&f.env);
    f.token().mint(&f.alice, &100i128);
    f.token().mint(&f.bob, &40i128);
    f.gov().delegate(&f.alice, &f.bob);
    f.gov().delegate(&f.alice, &carol);

    assert_eq!(f.gov().get_delegation(&f.alice), Some(carol.clone()));
    assert_eq!(f.gov().get_voting_power(&f.bob), 40);
    assert_eq!(f.gov().get_voting_power(&carol), 100);
}

#[test]
fn undelegating_without_a_delegation_is_rejected() {
    let f = setup();
    assert_contract_error(f.gov().try_undelegate(&f.alice), Error::NotDelegated);
}

#[test]
fn cannot_delegate_to_self() {
    let f = setup();
    f.token().mint(&f.alice, &100i128);
    assert_contract_error(
        f.gov().try_delegate(&f.alice, &f.alice),
        Error::InvalidDelegate,
    );
}

#[test]
fn delegating_without_a_balance_grants_no_power() {
    let f = setup();
    f.gov().delegate(&f.alice, &f.bob);

    assert_eq!(f.gov().get_delegation(&f.alice), Some(f.bob.clone()));
    assert_eq!(f.gov().get_voting_power(&f.bob), 0);
}
