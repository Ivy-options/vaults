// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    Bid,
    BID_TYPEHASH,
    Surface,
    SURFACE_TYPEHASH,
    SpotReport,
    SPOT_TYPEHASH,
    BASIS_SPOT,
    BASIS_STRIKE,
    BASIS_UNIT
} from "./IvyBidTypes.sol";

interface IHub {
    function vaultOf(uint256 vaultId) external view returns (address);
    function pairOf(uint256 vaultId, address quoteToken) external view returns (address premiumToken);
}

/// @title IvyVolBidder
/// @notice Delegated signing for a bidder: the desk signs a vol surface once, and this account approves each
///         final bid on its behalf. Works on an Ivy Vaults hub as deployed: no hub change needed.
/// @dev The hub verifies a bid with OpenZeppelin `SignatureChecker`. When the bidder address holds
///      code, that call becomes ERC-1271 `isValidSignature(hash, signature)` with the signature bytes
///      unconstrained. This contract uses them to carry the whole `Bid`, the desk's signed vol surface
///      and a signed spot, rebuilds the hub's typed-data digest, checks it matches the hash it was
///      handed, and then applies the desk's own limits. The desk therefore signs one surface per asset
///      pair instead of a price per auction: it stays valid across vaults, spot moves and the passage of
///      time, because it is quoted in coordinates where none of those change the answer.
///
///      Trust: the desk trusts `deskSigner` for quotes and `spotSigner` for the spot a quote is
///      evaluated at. It does not have to trust whoever assembles and submits the bid.
contract IvyVolBidder {
    using SafeERC20 for IERC20;

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 private constant ERC1271_FAIL = 0xffffffff;

    address public immutable hub;
    bytes32 public immutable hubDomainSeparator;

    address public owner; // cold key: funds, keys, allowance ceiling
    address public deskSigner; // hot key: signs surfaces only
    address public spotSigner; // whose spot observations the desk accepts
    address public killer; // may halt, nothing else
    bool public halted;
    uint64 public maxSpotAge; // seconds a spot observation stays usable
    uint256 public allowanceCap; // most this account will approve to any one vault

    mapping(bytes32 surfaceHash => bool) public revokedSurfaces;

    event OwnerChanged(address indexed previous, address indexed current);
    event KeysChanged(address deskSigner, address spotSigner, address killer);
    event LimitsChanged(uint64 maxSpotAge, uint256 allowanceCap);
    event Halted(address indexed by, bool halted);
    event SurfaceRevoked(bytes32 indexed surfaceHash);
    event VaultApproved(uint256 indexed vaultId, address indexed vault, address indexed token, uint256 amount);

    error NotOwner();
    error NotOwnerOrKiller();
    error NotOwnerOrDesk();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address hub_, address owner_, address deskSigner_, address spotSigner_, address killer_) {
        if (hub_ == address(0) || owner_ == address(0) || deskSigner_ == address(0) || spotSigner_ == address(0)) {
            revert ZeroAddress();
        }
        hub = hub_;
        owner = owner_;
        deskSigner = deskSigner_;
        spotSigner = spotSigner_;
        killer = killer_;
        maxSpotAge = 300;
        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            IERC5267(hub_).eip712Domain();
        hubDomainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
    }

    // ---------------------------------------------------------------- administration

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function setKeys(address deskSigner_, address spotSigner_, address killer_) external onlyOwner {
        if (deskSigner_ == address(0) || spotSigner_ == address(0)) revert ZeroAddress();
        deskSigner = deskSigner_;
        spotSigner = spotSigner_;
        killer = killer_;
        emit KeysChanged(deskSigner_, spotSigner_, killer_);
    }

    function setLimits(uint64 maxSpotAge_, uint256 allowanceCap_) external onlyOwner {
        maxSpotAge = maxSpotAge_;
        allowanceCap = allowanceCap_;
        emit LimitsChanged(maxSpotAge_, allowanceCap_);
    }

    /// @notice Stop accepting bids. Deliberately cheap to call and owner-only to undo.
    function halt(bool value) external {
        if (msg.sender != owner && msg.sender != killer) revert NotOwnerOrKiller();
        if (!value && msg.sender != owner) revert NotOwner();
        halted = value;
        emit Halted(msg.sender, value);
    }

    function revokeSurface(bytes32 hash_) external {
        if (msg.sender != owner && msg.sender != deskSigner) revert NotOwnerOrDesk();
        revokedSurfaces[hash_] = true;
        emit SurfaceRevoked(hash_);
    }

    /// @notice Approve a hub-registered vault clone up to `allowanceCap`. Permissionless on purpose:
    ///         the hub decides what its clones are, so this can only ever approve an address the hub
    ///         itself created, and never more than the owner's ceiling.
    function approveVault(uint256 vaultId, address token) external {
        address vault = IHub(hub).vaultOf(vaultId);
        if (vault == address(0)) revert ZeroAddress();
        IERC20(token).forceApprove(vault, allowanceCap);
        emit VaultApproved(vaultId, vault, token, allowanceCap);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------- ERC-1271

    /// @param hash      the hub's typed-data digest for the bid it is about to activate
    /// @param signature abi.encode(Bid, Surface, deskSignature, SpotReport, spotSignature)
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (halted) return ERC1271_FAIL;

        (Bid memory bid, Surface memory q, bytes memory deskSig, SpotReport memory spot, bytes memory spotSig) =
            abi.decode(signature, (Bid, Surface, bytes, SpotReport, bytes));

        // 1. the decoded bid must be exactly the bid the hub is verifying
        if (_bidDigest(bid) != hash) return ERC1271_FAIL;

        // 2. the quote and the spot must come from the keys this desk trusts
        bytes32 surfaceHash_ = _surfaceHash(q);
        if (revokedSurfaces[surfaceHash_]) return ERC1271_FAIL;
        if (ECDSA.recover(_digest(surfaceHash_), deskSig) != deskSigner) return ERC1271_FAIL;
        if (ECDSA.recover(_digest(_spotHash(spot)), spotSig) != spotSigner) return ERC1271_FAIL;

        // 3. scope: this account, this asset pair — read from the hub, not taken on trust from the blob
        if (bid.marketMaker != address(this)) return ERC1271_FAIL;
        if (bid.quoteToken != q.quoteToken) return ERC1271_FAIL;
        if (_underlyingOf(bid.vaultId) != q.underlying) return ERC1271_FAIL;
        if (IHub(hub).pairOf(bid.vaultId, bid.quoteToken) != q.premiumToken) return ERC1271_FAIL;
        if (spot.underlying != q.underlying || spot.quoteToken != q.quoteToken) return ERC1271_FAIL;

        // 4. freshness
        if (block.timestamp > q.validUntil) return ERC1271_FAIL;
        if (spot.observedAt > block.timestamp || block.timestamp - spot.observedAt > maxSpotAge) {
            return ERC1271_FAIL;
        }
        if (spot.spot == 0 || bid.expiry <= block.timestamp) return ERC1271_FAIL;

        // 5. the desk's own limits
        if (bid.collateralAmount > q.maxCollateral) return ERC1271_FAIL;
        if ((q.allowedStyles >> bid.style) & 1 == 0) return ERC1271_FAIL;
        if ((q.allowedSettlements >> bid.settlement) & 1 == 0) return ERC1271_FAIL;
        if (bid.executor != q.executor || bid.recipient != q.recipient) return ERC1271_FAIL;

        // 6. the price must sit under the surface at this spot and this time to expiry
        uint256 denominator = _basis(q, bid.strike, spot.spot);
        if (denominator == 0) return ERC1271_FAIL;
        uint256 maxBps = _maxPremiumBps(
            q, (bid.strike * 10_000) / spot.spot, uint256(bid.expiry) - block.timestamp
        );
        if (maxBps == 0 || bid.premiumPerUnit * 10_000 > maxBps * denominator) return ERC1271_FAIL;

        return ERC1271_MAGIC;
    }

    // ---------------------------------------------------------------- pricing

    /// @dev What one bp of premium is worth, per whole underlying, in premium-token units.
    ///      Spot and strike bases only make sense when premium is paid in the quote token.
    function _basis(Surface memory q, uint256 strike, uint256 spot) private pure returns (uint256) {
        if (q.premiumBasis == BASIS_UNIT) return q.premiumUnit;
        if (q.premiumToken != q.quoteToken) return 0;
        if (q.premiumBasis == BASIS_STRIKE) return strike;
        if (q.premiumBasis == BASIS_SPOT) return spot;
        return 0;
    }

    /// @dev Bilinear interpolation over (moneyness, time-to-expiry). Returns 0 outside the grid or on a
    ///      malformed grid, which rejects the bid: a desk quotes where it wants to trade, not everywhere.
    ///      The interpolation is linear in premium, so between nodes the ceiling is not the desk's model.
    ///      Across moneyness it sits on or above it (prices are convex in strike, for any arbitrage-free
    ///      surface); across tenor it sits below near the money and can sit above out of the money at
    ///      short tenors. Place nodes densely where you trade.
    function _maxPremiumBps(Surface memory q, uint256 moneynessBps, uint256 tau) private pure returns (uint256) {
        uint256 nm = q.moneynessBps.length;
        uint256 nt = q.tenors.length;
        if (nm < 2 || nt < 2 || q.premiumBps.length != nm * nt) return 0;
        (bool okM, uint256 i) = _segment(q.moneynessBps, moneynessBps);
        (bool okT, uint256 j) = _segment(q.tenors, tau);
        if (!okM || !okT) return 0;

        uint256 m0 = q.moneynessBps[i];
        uint256 m1 = q.moneynessBps[i + 1];
        uint256 t0 = q.tenors[j];
        uint256 t1 = q.tenors[j + 1];
        uint256 atT0 = _lerp(q.premiumBps[i * nt + j], q.premiumBps[(i + 1) * nt + j], moneynessBps - m0, m1 - m0);
        uint256 atT1 =
            _lerp(q.premiumBps[i * nt + j + 1], q.premiumBps[(i + 1) * nt + j + 1], moneynessBps - m0, m1 - m0);
        return _lerp(atT0, atT1, tau - t0, t1 - t0);
    }

    /// @dev Index i with xs[i] <= x <= xs[i+1]; false if x is outside the axis or the axis isn't ascending.
    function _segment(uint32[] memory xs, uint256 x) private pure returns (bool, uint256) {
        uint256 n = xs.length;
        if (x < xs[0] || x > xs[n - 1]) return (false, 0);
        for (uint256 i = 0; i + 1 < n; ++i) {
            if (xs[i + 1] <= xs[i]) return (false, 0);
            if (x <= xs[i + 1]) return (true, i);
        }
        return (false, 0);
    }

    function _lerp(uint256 a, uint256 b, uint256 dx, uint256 span) private pure returns (uint256) {
        return b >= a ? a + ((b - a) * dx) / span : a - ((a - b) * dx) / span;
    }

    /// @dev `underlying` is the first field of the hub's VaultTerms, which is all-static, so it is the
    ///      first word of `termsOf`'s return data. Read it raw to keep this contract free of the hub's
    ///      source tree. If their layout ever moves, this reads the wrong address and the scope check
    ///      fails closed.
    function _underlyingOf(uint256 vaultId) private view returns (address) {
        (bool ok, bytes memory ret) = hub.staticcall(abi.encodeWithSignature("termsOf(uint256)", vaultId));
        if (!ok || ret.length < 32) return address(0);
        return abi.decode(ret, (address));
    }

    // ---------------------------------------------------------------- hashing

    function _bidDigest(Bid memory bid) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", hubDomainSeparator, keccak256(abi.encode(BID_TYPEHASH, bid))));
    }

    /// @dev Surface and spot are signed under this contract's own domain, not the hub's.
    function _digest(bytes32 structHash) private view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("IvyVolBidder"),
                keccak256("2"),
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// @dev EIP-712 encodes a uint32[] as keccak256 of its elements each padded to 32 bytes, which is
    ///      exactly what abi.encodePacked does for arrays.
    function _surfaceHash(Surface memory q) private pure returns (bytes32) {
        bytes memory head = abi.encode(
            SURFACE_TYPEHASH,
            q.underlying,
            q.quoteToken,
            q.premiumToken,
            q.validUntil,
            q.maxCollateral,
            q.premiumBasis,
            q.premiumUnit,
            q.allowedStyles,
            q.allowedSettlements,
            q.executor,
            q.recipient
        );
        return keccak256(
            bytes.concat(
                head,
                abi.encode(
                    keccak256(abi.encodePacked(q.moneynessBps)),
                    keccak256(abi.encodePacked(q.tenors)),
                    keccak256(abi.encodePacked(q.premiumBps))
                )
            )
        );
    }

    function _spotHash(SpotReport memory s) private pure returns (bytes32) {
        return keccak256(abi.encode(SPOT_TYPEHASH, s.underlying, s.quoteToken, s.spot, s.observedAt));
    }

    /// @notice Hashes and digests a desk signs, exposed so tooling never re-implements them.
    function surfaceHash(Surface calldata q) external pure returns (bytes32) {
        return _surfaceHash(q);
    }

    function surfaceDigest(Surface calldata q) external view returns (bytes32) {
        return _digest(_surfaceHash(q));
    }

    function spotDigest(SpotReport calldata s) external view returns (bytes32) {
        return _digest(_spotHash(s));
    }

    /// @notice The most this account would pay, in premium-token units per whole underlying, for a
    ///         strike at this spot and expiry. For the bid master: compute the point, then submit.
    function maxPremiumPerUnit(Surface calldata q, uint256 strike, uint256 spot, uint64 expiry)
        external
        view
        returns (uint256)
    {
        if (spot == 0 || expiry <= block.timestamp) return 0;
        uint256 denominator = _basis(q, strike, spot);
        if (denominator == 0) return 0;
        return (_maxPremiumBps(q, (strike * 10_000) / spot, uint256(expiry) - block.timestamp) * denominator) / 10_000;
    }
}
