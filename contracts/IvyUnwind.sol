// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "./types/IvyTypes.sol";

/// @notice Consent and contribution ledger. Tokens remain reserved in each vault; hooks never move funds.
contract IvyUnwind is EIP712 {
    address public immutable hub;
    address public immutable shares;
    bytes32 public constant TYPEHASH = keccak256("UnwindAgreement(uint256 vaultId,uint256 nonce,uint64 deadline,uint256 exercisedNotional,uint256 supply,uint256 refund)");
    mapping(uint256 => UnwindAgreement) public agreements;
    mapping(uint256 => uint256) public approvedShares;
    struct Approval { uint256 nonce; uint256 balance; }
    struct Completion { bool executed; uint256 remainingWeight; uint256 remainingSurplus; }
    error FundingMissing();
    mapping(uint256 => uint256) public fundedShares;
    mapping(uint256 => uint256) public approvedRequired;
    mapping(uint256 => mapping(address => uint256)) public revisions;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public contributions;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public obligations;
    mapping(uint256 => mapping(uint256 => Completion)) public completions;
    event ContributionFunded(uint256 indexed vaultId, uint256 indexed nonce, address indexed holder, uint256 amount);
    event ContributionWithdrawn(uint256 indexed vaultId, uint256 indexed nonce, address indexed holder, uint256 amount);

    mapping(uint256 => mapping(address => Approval)) public approvals;
    event Proposed(uint256 indexed vaultId, uint256 nonce, bytes32 digest, uint64 deadline, uint256 exercisedNotional, uint256 supply, uint256 refund);
    event ApprovalUpdated(uint256 indexed vaultId, address indexed holder, uint256 nonce, uint256 balance);
    constructor(address hub_, address shares_) EIP712("IvyUnwind", "1") {
        if (hub_ == address(0) || shares_ == address(0)) revert ZeroAddress();
        hub = hub_; shares = shares_;
    }
    modifier onlyHub() { if (msg.sender != hub) revert NotHub(); _; }
    function hashAgreement(UnwindAgreement memory a) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TYPEHASH, a)));
    }
    function propose(uint256 id, uint64 deadline, uint256 exercised, uint256 supply, uint256 refund) external onlyHub {
        if (deadline <= block.timestamp || supply == 0) revert AgreementInvalid();
        uint256 nonce = agreements[id].nonce + 1;
        UnwindAgreement memory a = UnwindAgreement(id, nonce, deadline, exercised, supply, refund);
        agreements[id] = a;
        approvedShares[id] = 0;
        fundedShares[id] = 0;
        approvedRequired[id] = 0;
        emit Proposed(id, nonce, hashAgreement(a), deadline, exercised, supply, refund);
    }
    function approve(uint256 id, uint256 nonce, address holder, uint256 balance) external onlyHub {
        UnwindAgreement storage a = agreements[id];
        if (nonce == 0 || nonce != a.nonce || block.timestamp > a.deadline) revert AgreementInvalid();
        _invalidate(id, holder);
        if (balance == 0) revert AgreementInvalid();
        uint256 required = Math.mulDiv(a.refund, balance, a.supply, Math.Rounding.Ceil);
        obligations[id][nonce][holder] = required;
        approvedRequired[id] += required;
        if (contributions[id][nonce][holder] >= required) fundedShares[id] += balance;
        approvals[id][holder] = Approval(nonce, balance);
        approvedShares[id] += balance;
        emit ApprovalUpdated(id, holder, nonce, balance);
    }
    function revoke(uint256 id, address holder) external onlyHub { _invalidate(id, holder); }
    function beforeShareUpdate(uint256 id, address holder) external {
        if (msg.sender != shares) revert NotShares();
        _invalidate(id, holder);
    }
    function _invalidate(uint256 id, address holder) private {
        revisions[id][holder]++;
        Approval storage a = approvals[id][holder];
        if (completions[id][a.nonce].executed) { delete approvals[id][holder]; return; }
        if (a.nonce == agreements[id].nonce && a.balance > 0) {
            uint256 required = obligations[id][a.nonce][holder];
            approvedRequired[id] -= required;
            if (contributions[id][a.nonce][holder] >= required) fundedShares[id] -= a.balance;
            delete obligations[id][a.nonce][holder];
            approvedShares[id] -= a.balance;
            emit ApprovalUpdated(id, holder, a.nonce, 0);
        }
        delete approvals[id][holder];
    }
    /// @notice Rounded-up funding threshold for a holder balance in the current proposal.
    function requiredContribution(uint256 id, uint256 balance) external view returns (uint256) {
        UnwindAgreement storage a = agreements[id];
        if (a.nonce == 0) revert AgreementInvalid();
        return Math.mulDiv(a.refund, balance, a.supply, Math.Rounding.Ceil);
    }
    function fund(uint256 id, uint256 nonce, address holder, uint256 amount, uint256 exercised, uint256 revision) external onlyHub {
        UnwindAgreement storage a = agreements[id];
        if (nonce == 0 || nonce != a.nonce || block.timestamp > a.deadline || a.exercisedNotional != exercised || revisions[id][holder] != revision || amount == 0) revert AgreementInvalid();
        uint256 previous = contributions[id][nonce][holder];
        contributions[id][nonce][holder] = previous + amount;
        Approval storage approval = approvals[id][holder];
        uint256 required = obligations[id][nonce][holder];
        if (approval.nonce == nonce && previous < required && previous + amount >= required) fundedShares[id] += approval.balance;
        emit ContributionFunded(id, nonce, holder, amount);
    }
    /// @notice Before execution withdrawal revokes this holder's current consent. After execution only excess is recoverable.
    ///         Ceiling surplus is apportioned over remaining weights; the final withdrawing participant receives the dust.
    function withdraw(uint256 id, uint256 nonce, address holder) external onlyHub returns (uint256 amount) {
        amount = contributions[id][nonce][holder];
        if (amount == 0) revert NothingToClaim();
        Completion storage completion = completions[id][nonce];
        if (completion.executed) {
            uint256 weight = obligations[id][nonce][holder];
            delete obligations[id][nonce][holder];
            uint256 surplus = weight == 0 ? 0 : Math.mulDiv(completion.remainingSurplus, weight, completion.remainingWeight);
            completion.remainingWeight -= weight;
            completion.remainingSurplus -= surplus;
            amount = amount - weight + surplus;
        } else if (nonce == agreements[id].nonce) {
            // Invalidate against the original funded amount, before removing the ledger entry.
            _invalidate(id, holder);
        }
        delete contributions[id][nonce][holder];
        emit ContributionWithdrawn(id, nonce, holder, amount);
    }
    function refundOf(uint256 id) external view returns (uint256) { return agreements[id].refund; }
    function consume(uint256 id, uint256 nonce, uint256 exercised, uint256 supply, address buyer, bytes calldata signature)
        external onlyHub returns (uint256 refund)
    {
        UnwindAgreement memory a = agreements[id];
        if (nonce == 0 || nonce != a.nonce || block.timestamp > a.deadline || a.exercisedNotional != exercised || a.supply != supply) revert AgreementInvalid();
        if (approvedShares[id] != supply) revert ConsentMissing();
        if (fundedShares[id] != supply) revert FundingMissing();
        if (!SignatureChecker.isValidSignatureNow(buyer, hashAgreement(a), signature)) revert BadSignature();
        completions[id][nonce] = Completion(true, approvedRequired[id], approvedRequired[id] - a.refund);
        agreements[id].deadline = 0;
        return a.refund;
    }
}
