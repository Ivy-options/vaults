// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "./types/IvyTypes.sol";

/// @notice Consent ledger only. Hooks use local state and never call the hub.
contract IvyUnwind is EIP712 {
    address public immutable hub;
    address public immutable shares;
    bytes32 public constant TYPEHASH = keccak256("UnwindAgreement(uint256 vaultId,uint256 nonce,uint64 deadline,uint256 exercisedNotional,uint256 supply,uint256 refund)");
    mapping(uint256 => UnwindAgreement) public agreements;
    mapping(uint256 => uint256) public approvedShares;
    struct Approval { uint256 nonce; uint256 balance; }
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
        emit Proposed(id, nonce, hashAgreement(a), deadline, exercised, supply, refund);
    }
    function approve(uint256 id, uint256 nonce, address holder, uint256 balance) external onlyHub {
        UnwindAgreement storage a = agreements[id];
        if (nonce == 0 || nonce != a.nonce || block.timestamp > a.deadline) revert AgreementInvalid();
        _invalidate(id, holder);
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
        Approval storage a = approvals[id][holder];
        if (a.nonce == agreements[id].nonce && a.balance > 0) {
            approvedShares[id] -= a.balance;
            emit ApprovalUpdated(id, holder, a.nonce, 0);
        }
        delete approvals[id][holder];
    }
    function refundOf(uint256 id) external view returns (uint256) { return agreements[id].refund; }
    function consume(uint256 id, uint256 nonce, uint256 exercised, uint256 supply, address buyer, bytes calldata signature)
        external onlyHub returns (uint256 refund)
    {
        UnwindAgreement memory a = agreements[id];
        if (nonce == 0 || nonce != a.nonce || block.timestamp > a.deadline || a.exercisedNotional != exercised || a.supply != supply) revert AgreementInvalid();
        if (approvedShares[id] != supply) revert ConsentMissing();
        if (!SignatureChecker.isValidSignatureNow(buyer, hashAgreement(a), signature)) revert BadSignature();
        agreements[id].deadline = 0;
        return a.refund;
    }
}
