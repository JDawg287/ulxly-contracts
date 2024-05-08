import {ethers, upgrades} from "hardhat";
import {expect} from "chai";
import {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {ERC20PermitMock, PolygonZkEVMGlobalExitRoot, PolygonZkEVMBridgeV2, TokenWrapped} from "../../typechain-types";
import {MTBridge, mtBridgeUtils} from "@0xpolygonhermez/zkevm-commonjs";
import {ZeroAddress} from "ethers";

const {getLeafValue, verifyMerkleProof} = mtBridgeUtils;
const MerkleTreeBridge = MTBridge;

const _GLOBAL_INDEX_MAINNET_FLAG = 2n ** 64n;
const NETWORK_ID_MAINNET = 0;
const NETWORK_ID_ROLLUP = 1;
const NETWORK_ID_ROLLUP_2 = 2;
const LEAF_TYPE_ASSET = 0;
const AMOUNT = ethers.parseEther("2");
const HEIGHT = 32;
const NUMBER_OF_LEAVES_PER_BRIDGE = 2;

function calculateGlobalExitRoot(mainnetExitRoot: string, rollupExitRoot: string) {
    return ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [mainnetExitRoot, rollupExitRoot]);
}

function computeGlobalIndex(indexLocal: bigint, indexRollup: bigint, isMainnet: boolean) {
    return isMainnet ? indexLocal + _GLOBAL_INDEX_MAINNET_FLAG : indexLocal + indexRollup * 2n ** 32n;
}

function addLeafToJsTree(
    tree: typeof MerkleTreeBridge,
    leafType: number,
    originNetwork: number,
    tokenAddress: string,
    destinationNetwork: number,
    destinationAddress: string,
    amount: bigint,
    metadata: string
) {
    const metadataHash = ethers.solidityPackedKeccak256(["bytes"], [metadata]);
    const leafValue = getLeafValue(
        leafType,
        originNetwork,
        tokenAddress,
        destinationNetwork,
        destinationAddress,
        amount,
        metadataHash
    );
    tree.add(leafValue);
}

async function bridgeAsset(
    tokenAddress: string,
    destinationNetwork: number,
    destinationAddress: string,
    amount: bigint,
    bridge: PolygonZkEVMBridgeV2,
    acc: HardhatEthersSigner
) {
    await bridge.connect(acc).bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, "0x");
}

async function printBridgeEvents(bridge: PolygonZkEVMBridgeV2, logs: any[]) {
    const bridgeEventFilter = bridge.filters.BridgeEvent();
    const bridgeEvents = await bridge.queryFilter(bridgeEventFilter, 0, "latest");
    bridgeEvents.forEach((e) => {
        const {removed, blockNumber, transactionIndex, transactionHash, index, eventName, args} = e;
        const eventData = {
            leafType: args[0].toString(),
            originNetwork: args[1].toString(),
            originAddress: args[2],
            destinationNetwork: args[3].toString(),
            destinationAddress: args[4],
            amount: args[5].toString(),
            metadata: args[6],
            depositCount: args[7].toString(),
        };
        logs.push({removed, blockNumber, transactionIndex, transactionHash, index, eventName, eventData});
    });
}

async function transferAndApprove(bridge: PolygonZkEVMBridgeV2, token: any, amount: bigint, acc: HardhatEthersSigner) {
    await token.transfer(acc, amount);
    await token.connect(acc).approve(bridge.target, amount);
}

describe("PolygonZkEVMBridge Contract", () => {
    upgrades.silenceWarnings();

    let polygonZkEVMBridgeAContract: PolygonZkEVMBridgeV2;
    let polTokenContractMainnet: ERC20PermitMock;
    let polygonZkEVMGlobalExitRoot: PolygonZkEVMGlobalExitRoot;
    let polygonZkEVMBridgeBContract: PolygonZkEVMBridgeV2;
    let polygonZkEVMGlobalExitRootL2: PolygonZkEVMGlobalExitRoot;
    let deployer: any;
    let rollupManager: any;
    let acc1: any;
    let acc2: any;
    let acc3: any;
    let [userA, userB, userC] = ["", "", ""];

    const tokenName = "Matic Token";
    const tokenSymbol = "MATIC";
    const decimals = 18;
    const tokenInitialBalance = ethers.parseEther("20000000");
    const metadataToken = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint8"],
        [tokenName, tokenSymbol, decimals]
    );

    beforeEach("Deploy contracts", async () => {
        // load signers
        [deployer, rollupManager, acc1, acc2, acc3] = await ethers.getSigners();
        [userA, userB, userC] = [acc1.address, acc2.address, acc3.address];

        // deploy PolygonZkEVMBridge
        const polygonZkEVMBridgeFactory = await ethers.getContractFactory("PolygonZkEVMBridgeV2");
        polygonZkEVMBridgeAContract = (await upgrades.deployProxy(polygonZkEVMBridgeFactory, [], {
            initializer: false,
            unsafeAllow: ["constructor"],
        })) as unknown as PolygonZkEVMBridgeV2;

        // deploy global exit root manager
        const PolygonZkEVMGlobalExitRootFactory = await ethers.getContractFactory("PolygonZkEVMGlobalExitRoot");
        polygonZkEVMGlobalExitRoot = await PolygonZkEVMGlobalExitRootFactory.deploy(
            rollupManager.address,
            polygonZkEVMBridgeAContract.target
        );

        await polygonZkEVMBridgeAContract.initialize(
            NETWORK_ID_MAINNET,
            ethers.ZeroAddress, // zero for ether
            ethers.ZeroAddress, // zero for ether
            polygonZkEVMGlobalExitRoot.target,
            rollupManager.address,
            "0x"
        );

        // deploy token
        const maticTokenFactory = await ethers.getContractFactory("ERC20PermitMock");
        polTokenContractMainnet = await maticTokenFactory.deploy(
            tokenName,
            tokenSymbol,
            deployer.address,
            tokenInitialBalance
        );

        // deploy PolygonZkEVMBridgeB
        polygonZkEVMBridgeBContract = (await upgrades.deployProxy(polygonZkEVMBridgeFactory, [], {
            initializer: false,
            unsafeAllow: ["constructor"],
        })) as unknown as PolygonZkEVMBridgeV2;

        polygonZkEVMGlobalExitRootL2 = await PolygonZkEVMGlobalExitRootFactory.deploy(
            rollupManager.address,
            polygonZkEVMBridgeBContract.target
        );

        await polygonZkEVMBridgeBContract.initialize(
            NETWORK_ID_ROLLUP,
            ethers.ZeroAddress, // zero for ether
            ethers.ZeroAddress, // zero for ether
            polygonZkEVMGlobalExitRootL2.target,
            rollupManager.address,
            "0x"
        );
    });

    type Output = {
        mainnetBridge: string;
        rollupBridge: string;
        tokenMainnet: string;
        tokenWrappedRollup: string;
        userAAddr: string;
        userBAddr: string;
        userCAddr: string;
        userABalanceBefore: number;
        userABalanceAfterBridge: number;
        userBBalanceAfterClaim: number;
        userBBalanceAfterBridge: number;
    };

    it("simulates a dependant bridge", async () => {
        let logs: any[] = [];
        let output: Output = {
            mainnetBridge: polygonZkEVMBridgeAContract.target as string,
            rollupBridge: polygonZkEVMBridgeBContract.target as string,
            tokenMainnet: polTokenContractMainnet.target as string,
            tokenWrappedRollup: "",
            userAAddr: userA,
            userBAddr: userB,
            userCAddr: userC,
            userABalanceBefore: 0,
            userABalanceAfterBridge: 0,
            userBBalanceAfterClaim: 0,
            userBBalanceAfterBridge: 0,
        };

        //////////// Bridge Mainnet to Rollup ////////////

        let merkleTreeMainnet = new MerkleTreeBridge(HEIGHT);
        let totalAmountBridgeA: bigint = BigInt(0);

        let mainnetExitRootJS,
            mainnetExitRootSC,
            rollupExitRootJS,
            rollupExitRootSC = ethers.ZeroHash;

        await transferAndApprove(
            polygonZkEVMBridgeAContract,
            polTokenContractMainnet,
            AMOUNT * BigInt(NUMBER_OF_LEAVES_PER_BRIDGE),
            acc1
        );

        output.userABalanceBefore = Number(await polTokenContractMainnet.balanceOf(userA));

        await ethers.provider.send("hardhat_impersonateAccount", [polygonZkEVMBridgeBContract.target]);
        const bridgeBAcc = await ethers.getSigner(polygonZkEVMBridgeBContract.target as any);

        for (let i = 0; i < NUMBER_OF_LEAVES_PER_BRIDGE; i++) {
            addLeafToJsTree(
                merkleTreeMainnet,
                LEAF_TYPE_ASSET,
                NETWORK_ID_MAINNET,
                polTokenContractMainnet.target as string,
                NETWORK_ID_ROLLUP,
                userB,
                AMOUNT,
                metadataToken
            );

            mainnetExitRootJS = merkleTreeMainnet.getRoot();
            mainnetExitRootSC = await polygonZkEVMGlobalExitRoot.lastMainnetExitRoot();

            await bridgeAsset(
                polTokenContractMainnet.target as string,
                NETWORK_ID_ROLLUP,
                userB,
                AMOUNT,
                polygonZkEVMBridgeAContract,
                acc1
            );

            totalAmountBridgeA += AMOUNT;

            // simulate global exit root update for bridge B by updating the mainnet exit root manually
            await polygonZkEVMGlobalExitRootL2.connect(bridgeBAcc).updateExitRoot(mainnetExitRootJS, {gasPrice: 0});
        }
        await printBridgeEvents(polygonZkEVMBridgeAContract, logs);

        // userA balance should be since all of it was bridged
        expect(await polTokenContractMainnet.balanceOf(userA)).to.be.equal(0);
        output.userABalanceAfterBridge = Number(await polTokenContractMainnet.balanceOf(userA));

        // update global exit root
        const indexRollup = 5;

        const merkleTreeRollup = new MerkleTreeBridge(HEIGHT);
        for (let i = 0; i < 10; i++) {
            if (i == indexRollup) {
                merkleTreeRollup.add(mainnetExitRootJS);
            } else {
                merkleTreeRollup.add(ethers.toBeHex(ethers.toQuantity(ethers.randomBytes(32)), 32));
            }
        }

        mainnetExitRootSC = await polygonZkEVMGlobalExitRoot.lastMainnetExitRoot();
        mainnetExitRootJS = merkleTreeMainnet.getRoot();
        rollupExitRootJS = merkleTreeRollup.getRoot();

        await expect(polygonZkEVMGlobalExitRoot.connect(rollupManager).updateExitRoot(rollupExitRootJS))
            .to.emit(polygonZkEVMGlobalExitRoot, "UpdateGlobalExitRoot")
            .withArgs(mainnetExitRootSC, rollupExitRootJS);

        rollupExitRootSC = await polygonZkEVMGlobalExitRoot.lastRollupExitRoot();
        expect(rollupExitRootJS).to.be.equal(rollupExitRootSC);

        const computedGlobalExitRoot = calculateGlobalExitRoot(mainnetExitRootJS, rollupExitRootSC);
        expect(computedGlobalExitRoot).to.be.equal(await polygonZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        // simulate global exit root update for bridge B by updating the rollup exit root manually
        await polygonZkEVMGlobalExitRootL2.connect(rollupManager).updateExitRoot(rollupExitRootJS);

        //////////// Bridge Rollup to Mainnet ////////////

        let merkleTreeRollupBridgeJS = new MerkleTreeBridge(HEIGHT);
        let totalAmountBridgeB: bigint = 0n;
        let rollupExitRootBridgeBJS,
            rollupExitRootBridgeBSC = ethers.ZeroHash;

        // get wrapped token address that will be created on the rollup network
        const tokenWrappedFactory = await ethers.getContractFactory("TokenWrapped");
        const salt = ethers.solidityPackedKeccak256(
            ["uint32", "address"],
            [NETWORK_ID_MAINNET, polTokenContractMainnet.target]
        );
        const minimalBytecodeProxy = await polygonZkEVMBridgeBContract.BASE_INIT_BYTECODE_WRAPPED_TOKEN();
        const hashInitCode = ethers.solidityPackedKeccak256(["bytes", "bytes"], [minimalBytecodeProxy, metadataToken]);
        const precalculateWrappedErc20 = ethers.getCreate2Address(
            polygonZkEVMBridgeBContract.target as string,
            salt,
            hashInitCode
        );
        const newWrappedToken = tokenWrappedFactory.attach(precalculateWrappedErc20) as TokenWrapped;
        output.tokenWrappedRollup = newWrappedToken.target as string;

        let indexLocal = 0;
        for (let i = 0; i < NUMBER_OF_LEAVES_PER_BRIDGE; i++) {
            // get proofs
            indexLocal = i;
            const proofLocal = merkleTreeMainnet.getProofTreeByIndex(indexLocal);
            const proofRollup = merkleTreeRollup.getProofTreeByIndex(indexRollup);

            // verify merkle proof
            expect(verifyMerkleProof(mainnetExitRootJS, proofRollup, indexRollup, rollupExitRootJS)).to.be.equal(true);
            expect(
                await polygonZkEVMBridgeAContract.verifyMerkleProof(
                    mainnetExitRootJS,
                    proofRollup,
                    indexRollup,
                    rollupExitRootJS
                )
            ).to.be.equal(true);

            const globalIndex = computeGlobalIndex(BigInt(indexLocal), BigInt(indexRollup), false);

            await expect(
                polygonZkEVMBridgeBContract.claimAsset(
                    proofLocal,
                    proofRollup,
                    Number(globalIndex),
                    mainnetExitRootSC,
                    rollupExitRootSC,
                    NETWORK_ID_MAINNET,
                    polTokenContractMainnet.target,
                    NETWORK_ID_ROLLUP,
                    userB,
                    AMOUNT,
                    metadataToken
                )
            )
                .to.emit(polygonZkEVMBridgeBContract, "ClaimEvent")
                .withArgs(globalIndex, NETWORK_ID_MAINNET, polTokenContractMainnet.target, userB, AMOUNT)
                .to.emit(newWrappedToken, "Transfer")
                .withArgs(ZeroAddress, userB, AMOUNT);
        }

        //check balance of the destination address
        expect(await newWrappedToken.balanceOf(userB)).to.be.equal(AMOUNT * BigInt(NUMBER_OF_LEAVES_PER_BRIDGE));
        output.userBBalanceAfterClaim = Number(await newWrappedToken.balanceOf(userB));

        for (let i = 0; i < NUMBER_OF_LEAVES_PER_BRIDGE; i++) {
            addLeafToJsTree(
                merkleTreeRollupBridgeJS,
                LEAF_TYPE_ASSET,
                NETWORK_ID_ROLLUP,
                newWrappedToken.target as string,
                NETWORK_ID_ROLLUP_2,
                userC,
                AMOUNT,
                metadataToken
            );

            rollupExitRootBridgeBJS = merkleTreeMainnet.getRoot();
            rollupExitRootBridgeBSC = await polygonZkEVMGlobalExitRoot.lastRollupExitRoot();

            await bridgeAsset(
                newWrappedToken.target as string,
                NETWORK_ID_ROLLUP_2,
                userC,
                AMOUNT,
                polygonZkEVMBridgeBContract,
                acc2
            );

            totalAmountBridgeB += AMOUNT;
        }
        await printBridgeEvents(polygonZkEVMBridgeBContract, logs);

        await polygonZkEVMBridgeBContract.updateGlobalExitRoot();
        let computedGlobalExitRootRollup = calculateGlobalExitRoot(rollupExitRootBridgeBJS, rollupExitRootBridgeBSC);
        expect(computedGlobalExitRootRollup).to.be.equal(await polygonZkEVMGlobalExitRoot.getLastGlobalExitRoot());

        expect(await newWrappedToken.balanceOf(userB)).to.be.equal(0);
        output.userBBalanceAfterBridge = Number(await newWrappedToken.balanceOf(userB));
        console.log(JSON.stringify(output, null, 2));
        console.log(JSON.stringify(logs, null, 2));
    });
});
