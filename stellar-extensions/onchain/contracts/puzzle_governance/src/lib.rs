// Allow `std` access during `cargo test` while keeping the deployed contract
// `no_std` for the WASM build.
#![cfg_attr(not(test), no_std)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short,
    token::TokenClient, Address, Env, String,
};

// ---------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Contract configuration (admin, governance token, defaults).
    Config,
    /// Next proposal id to hand out.
    NextProposalId,
    /// A proposal by id.
    Proposal(u64),
    /// Recorded vote for (proposal, voter); presence also prevents re-votes.
    Vote(u64, Address),
    /// Account -> account it currently delegates to.
    Delegation(Address),
    /// Voting power an account has received from its delegators.
    DelegatedPower(Address),
    /// Voting power an account moved to its delegate at delegation time.
    DelegationRecord(Address),
}

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug)]
pub struct Config {
    pub admin: Address,
    /// SEP-41 token used to weight votes.
    pub token: Address,
    /// Default voting window, in ledgers, applied to new proposals.
    pub default_voting_period: u32,
    /// Minimum total voting power (for + against) required for a proposal
    /// outcome to be valid. Expressed in token base units.
    pub quorum: i128,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VoteKind {
    Against = 0,
    For = 1,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProposalStatus {
    /// Inside the voting window.
    Active = 0,
    /// Closed with quorum and more For than Against votes.
    Succeeded = 1,
    /// Closed without quorum, or with at least as many Against votes.
    Defeated = 2,
    /// Succeeded proposal that has been executed.
    Executed = 3,
    /// Cancelled by the proposer or admin before execution.
    Cancelled = 4,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    /// Puzzle this proposal applies to.
    pub puzzle_id: u64,
    pub title: String,
    pub description: String,
    pub created_at: u32,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub for_votes: i128,
    pub against_votes: i128,
    pub status: ProposalStatus,
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
    AlreadyInitialized = 2,
    NotInitialized = 3,
    ProposalNotFound = 4,
    InvalidDuration = 5,
    InvalidQuorum = 6,
    InvalidTitle = 7,
    InvalidDescription = 8,
    ProposalNotActive = 9,
    VotingClosed = 10,
    VotingStillOpen = 11,
    AlreadyVoted = 12,
    NoVotingPower = 13,
    AlreadyDelegated = 14,
    NotDelegated = 15,
    InvalidDelegate = 16,
    ProposalNotSucceeded = 17,
}

const MAX_TITLE_LEN: u32 = 120;
const MAX_DESCRIPTION_LEN: u32 = 1024;

// Ledger TTL bumps: keep governance state available for roughly a month,
// refreshing on every write.
const INSTANCE_BUMP_THRESHOLD: u32 = 17_280;
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
const PERSISTENT_BUMP_THRESHOLD: u32 = 17_280;
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;

// ---------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------

#[contract]
pub struct PuzzleGovernance;

#[contractimpl]
impl PuzzleGovernance {
    /// Configure governance exactly once.
    ///
    /// * `admin` — account allowed to tune quorum and the default duration.
    /// * `token` — SEP-41 token whose balances weight votes.
    /// * `default_voting_period` — default voting window in ledgers (> 0).
    /// * `quorum` — absolute token amount that must participate (>= 0).
    pub fn init(
        env: Env,
        admin: Address,
        token: Address,
        default_voting_period: u32,
        quorum: i128,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        admin.require_auth();

        if default_voting_period == 0 {
            panic_with_error!(&env, Error::InvalidDuration);
        }
        if quorum < 0 {
            panic_with_error!(&env, Error::InvalidQuorum);
        }

        let config = Config {
            admin,
            token,
            default_voting_period,
            quorum,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::NextProposalId, &0u64);
        bump_instance(&env);
    }

    /// Create a puzzle-change proposal. The voting window starts immediately
    /// and defaults to `Config::default_voting_period` unless overridden.
    ///
    /// Returns the new proposal id.
    pub fn propose(
        env: Env,
        proposer: Address,
        puzzle_id: u64,
        title: String,
        description: String,
        voting_period: Option<u32>,
    ) -> u64 {
        let config = load_config(&env);
        proposer.require_auth();

        let title_len = title.len();
        if title_len == 0 || title_len > MAX_TITLE_LEN {
            panic_with_error!(&env, Error::InvalidTitle);
        }
        if description.len() > MAX_DESCRIPTION_LEN {
            panic_with_error!(&env, Error::InvalidDescription);
        }

        let duration = match voting_period {
            Some(period) => period,
            None => config.default_voting_period,
        };
        if duration == 0 {
            panic_with_error!(&env, Error::InvalidDuration);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextProposalId)
            .unwrap_or(0u64);
        let start_ledger = env.ledger().sequence();
        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            puzzle_id,
            title,
            description,
            created_at: start_ledger,
            start_ledger,
            end_ledger: start_ledger + duration,
            for_votes: 0,
            against_votes: 0,
            status: ProposalStatus::Active,
        };

        let key = DataKey::Proposal(id);
        env.storage().persistent().set(&key, &proposal);
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        env.storage()
            .instance()
            .set(&DataKey::NextProposalId, &(id + 1));
        bump_instance(&env);

        env.events()
            .publish((symbol_short!("prop_new"), id), (proposer, puzzle_id));

        id
    }

    /// Cast a token-weighted vote while the proposal is active.
    ///
    /// Voting power is the caller's current token balance plus any power
    /// delegated to it. An account that has delegated its own power away
    /// must not vote directly.
    pub fn vote(env: Env, voter: Address, proposal_id: u64, support: VoteKind) {
        let config = load_config(&env);
        voter.require_auth();

        let mut proposal = load_proposal(&env, proposal_id);
        if proposal.status != ProposalStatus::Active {
            panic_with_error!(&env, Error::ProposalNotActive);
        }
        if env.ledger().sequence() > proposal.end_ledger {
            panic_with_error!(&env, Error::VotingClosed);
        }

        let vote_key = DataKey::Vote(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            panic_with_error!(&env, Error::AlreadyVoted);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Delegation(voter.clone()))
        {
            panic_with_error!(&env, Error::AlreadyDelegated);
        }

        let weight = voting_power(&env, &config, &voter);
        if weight <= 0 {
            panic_with_error!(&env, Error::NoVotingPower);
        }

        match support {
            VoteKind::For => proposal.for_votes += weight,
            VoteKind::Against => proposal.against_votes += weight,
        }
        env.storage()
            .persistent()
            .set(&vote_key, &(support, weight));
        env.storage()
            .persistent()
            .extend_ttl(&vote_key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        let proposal_key = DataKey::Proposal(proposal_id);
        env.storage().persistent().set(&proposal_key, &proposal);
        env.storage().persistent().extend_ttl(
            &proposal_key,
            PERSISTENT_BUMP_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events()
            .publish((symbol_short!("vote"), proposal_id), (voter, weight));
    }

    /// Close voting after the window ends and record the outcome.
    ///
    /// Permissionless: anyone may finalize once `end_ledger` has passed.
    pub fn finalize(env: Env, proposal_id: u64) -> ProposalStatus {
        let config = load_config(&env);
        let mut proposal = load_proposal(&env, proposal_id);

        if proposal.status != ProposalStatus::Active {
            return proposal.status;
        }
        if env.ledger().sequence() <= proposal.end_ledger {
            panic_with_error!(&env, Error::VotingStillOpen);
        }

        let total_votes = proposal.for_votes + proposal.against_votes;
        let status = if total_votes < config.quorum {
            // Quorum is a validity threshold: an under-attended proposal
            // cannot pass even if every vote was For.
            ProposalStatus::Defeated
        } else if proposal.for_votes > proposal.against_votes {
            ProposalStatus::Succeeded
        } else {
            ProposalStatus::Defeated
        };
        proposal.status = status;

        let key = DataKey::Proposal(proposal_id);
        env.storage().persistent().set(&key, &proposal);
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);

        env.events()
            .publish((symbol_short!("finalized"), proposal_id), status);

        status
    }

    /// Execute an approved proposal.
    ///
    /// Puzzle proposals describe off-chain content changes rather than
    /// arbitrary contract calls, so execution records the approved decision
    /// on-chain and emits an event indexers/relayers can consume. It is
    /// idempotent only in the sense that a second call is rejected.
    pub fn execute(env: Env, executor: Address, proposal_id: u64) {
        let mut proposal = load_proposal(&env, proposal_id);
        executor.require_auth();

        if proposal.status == ProposalStatus::Active {
            panic_with_error!(&env, Error::VotingStillOpen);
        }
        if proposal.status != ProposalStatus::Succeeded {
            panic_with_error!(&env, Error::ProposalNotSucceeded);
        }

        proposal.status = ProposalStatus::Executed;
        let key = DataKey::Proposal(proposal_id);
        env.storage().persistent().set(&key, &proposal);
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("executed"), proposal_id),
            (executor, proposal.puzzle_id),
        );
    }

    /// Cancel a proposal that has not been executed. Only the proposer or the
    /// admin may cancel.
    pub fn cancel(env: Env, caller: Address, proposal_id: u64) {
        let config = load_config(&env);
        let mut proposal = load_proposal(&env, proposal_id);
        caller.require_auth();

        if caller != proposal.proposer && caller != config.admin {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        match proposal.status {
            ProposalStatus::Active | ProposalStatus::Succeeded | ProposalStatus::Defeated => {}
            _ => panic_with_error!(&env, Error::ProposalNotActive),
        }

        proposal.status = ProposalStatus::Cancelled;
        let key = DataKey::Proposal(proposal_id);
        env.storage().persistent().set(&key, &proposal);
        env.storage()
            .persistent()
            .extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);

        env.events()
            .publish((symbol_short!("cancelled"), proposal_id), caller);
    }

    /// Move the caller's current token balance to `to` as voting power.
    ///
    /// Delegation is a single hop: power received from other delegators is
    /// not re-delegated. The amount moved is captured at delegation time, so
    /// balance changes afterwards do not silently rewrite past delegation;
    /// call `delegate` again to re-capture.
    pub fn delegate(env: Env, from: Address, to: Address) {
        let config = load_config(&env);
        from.require_auth();

        if from == to {
            panic_with_error!(&env, Error::InvalidDelegate);
        }

        let balance = token_balance(&env, &config, &from);
        if balance < 0 {
            panic_with_error!(&env, Error::NoVotingPower);
        }

        // Revoke an existing delegation before moving power again.
        if let Some(previous) = env
            .storage()
            .persistent()
            .get::<DataKey, Address>(&DataKey::Delegation(from.clone()))
        {
            let moved: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::DelegationRecord(from.clone()))
                .unwrap_or(0);
            reduce_delegated_power(&env, &previous, moved);
        }

        set_delegated_power(
            &env,
            &to,
            delegated_power(&env, &to).checked_add(balance).unwrap(),
        );
        env.storage()
            .persistent()
            .set(&DataKey::Delegation(from.clone()), &to);
        env.storage()
            .persistent()
            .set(&DataKey::DelegationRecord(from.clone()), &balance);
        for key in [
            DataKey::Delegation(from.clone()),
            DataKey::DelegationRecord(from.clone()),
        ] {
            env.storage()
                .persistent()
                .extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        }
        // `set_delegated_power` clears the entry when the moved power is zero,
        // so only bump the TTL of a delegate that actually holds power.
        let power_key = DataKey::DelegatedPower(to.clone());
        if env.storage().persistent().has(&power_key) {
            env.storage().persistent().extend_ttl(
                &power_key,
                PERSISTENT_BUMP_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }

        env.events()
            .publish((symbol_short!("delegate"), from), (to, balance));
    }

    /// Revoke the caller's delegation. Power recorded at delegation time is
    /// removed from the delegate; votes already cast are unaffected.
    pub fn undelegate(env: Env, from: Address) {
        from.require_auth();

        let to: Address = match env
            .storage()
            .persistent()
            .get(&DataKey::Delegation(from.clone()))
        {
            Some(delegate) => delegate,
            None => panic_with_error!(&env, Error::NotDelegated),
        };
        let moved: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::DelegationRecord(from.clone()))
            .unwrap_or(0);

        reduce_delegated_power(&env, &to, moved);
        env.storage()
            .persistent()
            .remove(&DataKey::Delegation(from.clone()));
        env.storage()
            .persistent()
            .remove(&DataKey::DelegationRecord(from.clone()));

        env.events()
            .publish((symbol_short!("undelegat"), from), (to, moved));
    }

    /// Update the participation quorum (token base units). Admin only.
    pub fn set_quorum(env: Env, admin: Address, quorum: i128) {
        let mut config = load_config(&env);
        admin.require_auth();

        if admin != config.admin {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        if quorum < 0 {
            panic_with_error!(&env, Error::InvalidQuorum);
        }
        config.quorum = quorum;
        env.storage().instance().set(&DataKey::Config, &config);
        bump_instance(&env);

        env.events().publish((symbol_short!("quorum"),), quorum);
    }

    /// Update the default voting window (ledgers) applied to new proposals.
    pub fn set_default_voting_period(env: Env, admin: Address, period: u32) {
        let mut config = load_config(&env);
        admin.require_auth();

        if admin != config.admin {
            panic_with_error!(&env, Error::NotAuthorized);
        }
        if period == 0 {
            panic_with_error!(&env, Error::InvalidDuration);
        }
        config.default_voting_period = period;
        env.storage().instance().set(&DataKey::Config, &config);
        bump_instance(&env);

        env.events().publish((symbol_short!("duration"),), period);
    }

    // -----------------------------------------------------------------
    // Read-only views
    // -----------------------------------------------------------------

    pub fn get_config(env: Env) -> Config {
        load_config(&env)
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Proposal {
        load_proposal(&env, proposal_id)
    }

    pub fn get_proposal_count(env: Env) -> u64 {
        load_config(&env);
        env.storage()
            .instance()
            .get(&DataKey::NextProposalId)
            .unwrap_or(0u64)
    }

    /// Voting power `account` can currently use: its token balance plus power
    /// delegated to it, or zero when it has delegated its own power away.
    pub fn get_voting_power(env: Env, account: Address) -> i128 {
        let config = load_config(&env);
        voting_power(&env, &config, &account)
    }

    pub fn get_delegation(env: Env, account: Address) -> Option<Address> {
        load_config(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Delegation(account))
    }

    pub fn has_voted(env: Env, proposal_id: u64, voter: Address) -> bool {
        load_config(&env);
        env.storage()
            .persistent()
            .has(&DataKey::Vote(proposal_id, voter))
    }

    pub fn get_vote(env: Env, proposal_id: u64, voter: Address) -> Option<(VoteKind, i128)> {
        load_config(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Vote(proposal_id, voter))
    }
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

fn load_config(env: &Env) -> Config {
    match env.storage().instance().get::<DataKey, Config>(&DataKey::Config) {
        Some(config) => config,
        None => panic_with_error!(env, Error::NotInitialized),
    }
}

fn load_proposal(env: &Env, proposal_id: u64) -> Proposal {
    let key = DataKey::Proposal(proposal_id);
    match env.storage().persistent().get::<DataKey, Proposal>(&key) {
        Some(proposal) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
            proposal
        }
        None => panic_with_error!(env, Error::ProposalNotFound),
    }
}

fn token_balance(env: &Env, config: &Config, account: &Address) -> i128 {
    TokenClient::new(env, &config.token).balance(account)
}

fn voting_power(env: &Env, config: &Config, account: &Address) -> i128 {
    if env
        .storage()
        .persistent()
        .has(&DataKey::Delegation(account.clone()))
    {
        return 0;
    }
    token_balance(env, config, account)
        .checked_add(delegated_power(env, account))
        .unwrap()
}

fn delegated_power(env: &Env, account: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::DelegatedPower(account.clone()))
        .unwrap_or(0)
}

fn set_delegated_power(env: &Env, account: &Address, power: i128) {
    let key = DataKey::DelegatedPower(account.clone());
    if power == 0 {
        if env.storage().persistent().has(&key) {
            env.storage().persistent().remove(&key);
        }
        return;
    }
    env.storage().persistent().set(&key, &power);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
}

fn reduce_delegated_power(env: &Env, account: &Address, amount: i128) {
    let current = delegated_power(env, account);
    set_delegated_power(env, account, current.checked_sub(amount).unwrap_or(0));
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

#[cfg(test)]
mod test;
