# Wallet

This directory will hold the root `@steelyard/buyer` Wallet facade.

The package root export stays disabled until the Wallet can compose the policy
engine and vault end to end. That preserves the no-stubs rule: juniors should
not be able to import a partial `Wallet`.
