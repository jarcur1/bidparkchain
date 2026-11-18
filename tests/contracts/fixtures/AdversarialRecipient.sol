// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Test-only actor: can own auctions, bid, and reject or reenter ETH transfers.
contract AdversarialRecipient {
    address public immutable escrow;
    bool public rejectEther;
    bool public swallowFailure;
    bytes public callback;
    bytes4 public lastError;
    uint256 public received;

    constructor(address target) { escrow = target; }

    function configure(bool reject, bytes calldata reentry, bool swallow) external {
        rejectEther = reject;
        callback = reentry;
        swallowFailure = swallow;
        lastError = bytes4(0);
    }

    function execute(bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory result) = escrow.call{value: msg.value}(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
        return result;
    }

    receive() external payable {
        require(!rejectEther, "recipient rejects ETH");
        received += msg.value;
        if (callback.length != 0) {
            (bool ok, bytes memory result) = escrow.call(callback);
            if (!ok) {
                if (!swallowFailure) assembly { revert(add(result, 32), mload(result)) }
                lastError = bytes4(result);
            }
        }
    }
}
