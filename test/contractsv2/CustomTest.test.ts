import {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {expect} from "chai";
import {ethers, upgrades} from "hardhat";
import {ERC20PermitMock, PolygonZkEVMGlobalExitRoot, PolygonZkEVMBridgeV2} from "../../typechain-types";
import {MTBridge, mtBridgeUtils} from "@0xpolygonhermez/zkevm-commonjs";
const MerkleTreeBridge = MTBridge;
const {getLeafValue} = mtBridgeUtils;

function calculateGlobalExitRoot(mainnetExitRoot: any, rollupExitRoot: any) {
    return ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [mainnetExitRoot, rollupExitRoot]);
}
const _GLOBAL_INDEX_MAINNET_FLAG = 2n ** 64n;

function computeGlobalIndex(indexLocal: any, indexRollup: any, isMainnet: Boolean) {
    if (isMainnet === true) {
        return BigInt(indexLocal) + _GLOBAL_INDEX_MAINNET_FLAG;
    } else {
        return BigInt(indexLocal) + BigInt(indexRollup) * 2n ** 32n;
    }
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
    leafType: number,
    originNetwork: number,
    tokenAddress: string,
    destinationNetwork: number,
    destinationAddress: string,
    amount: bigint,
    metadata: string,
    depositCount: number,
    bridge: PolygonZkEVMBridgeV2,
    globalExitRoot: PolygonZkEVMGlobalExitRoot,
    acc: HardhatEthersSigner,
    rootJS: string,
    rollupExitRoot: string,
    tokenContract: ERC20PermitMock
) {
    await expect(
        bridge.connect(acc).bridgeAsset(destinationNetwork, destinationAddress, amount, tokenAddress, true, "0x")
    )
        .to.emit(bridge, "BridgeEvent")
        .withArgs(
            leafType,
            originNetwork,
            tokenAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            metadata,
            depositCount
        )
        .to.emit(globalExitRoot, "UpdateGlobalExitRoot")
        .withArgs(rootJS, rollupExitRoot)
        .to.emit(tokenContract, "Transfer")
        .withArgs(acc.address, bridge.target, amount);
}

async function printBridgeEvents(bridge: PolygonZkEVMBridgeV2, totalDepositCount: number) {
    console.log("[");
    const bridgeEventFilter = bridge.filters.BridgeEvent();
    const bridgeEvents = await bridge.queryFilter(bridgeEventFilter, 0, "latest");
    bridgeEvents.forEach((e) => {
        const {removed, blockNumber, transactionIndex, transactionHash, index, eventName, args} = e;
        const leafType = args[0].toString();
        const originNetwork = args[1].toString();
        const originAddress = args[2];
        const destinationNetwork = args[3].toString();
        const destinationAddress = args[4];
        const amount = args[5].toString();
        const metadata = args[6];
        const depositCount = args[7].toString();
        console.log(
            JSON.stringify(
                {
                    removed,
                    blockNumber,
                    transactionIndex,
                    transactionHash,
                    index,
                    eventName,
                    eventData: {
                        leafType,
                        originNetwork,
                        originAddress,
                        destinationNetwork,
                        destinationAddress,
                        amount,
                        metadata,
                        depositCount,
                    },
                },
                null,
                2
            ),
            args[7] != BigInt(totalDepositCount - 1) ? "," : ""
        );
    });
    console.log("]");
}

async function transferAndApprove(bridge: PolygonZkEVMBridgeV2, token: any, amount: bigint, acc: HardhatEthersSigner) {
    await token.transfer(acc, amount);
    token.connect(acc).approve(bridge.target, amount);
}

describe("PolygonZkEVMBridge Contract", () => {
    upgrades.silenceWarnings();

    let polygonZkEVMBridgeAContract: PolygonZkEVMBridgeV2;
    let polTokenContractNetwork0: ERC20PermitMock;
    let polygonZkEVMGlobalExitRootMainnet: PolygonZkEVMGlobalExitRoot;

    let polygonZkEVMBridgeBContract: PolygonZkEVMBridgeV2;
    let polygonZkEVMGlobalExitRootRollup: PolygonZkEVMGlobalExitRoot;

    let deployer: any;
    let rollupManager: any;
    let acc1: any;
    let acc2: any;
    let acc3: any;

    const tokenName = "Matic Token";
    const tokenSymbol = "MATIC";
    const decimals = 18;
    const tokenInitialBalance = ethers.parseEther("20000000");
    const metadataToken = ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "string", "uint8"],
        [tokenName, tokenSymbol, decimals]
    );
    const networkIDMainnet = 0;
    const networkIDRollup = 1;
    const networkIDRollup2 = 2;

    const LEAF_TYPE_ASSET = 0;
    // const LEAF_TYPE_MESSAGE = 1;

    const AMOUNT = ethers.parseEther("10");
    const HEIGHT = 32;
    const NUMBER_OF_LEAVES_PER_BRIDGE = 1;

    let [userA, userB, userC] = ["", "", ""];

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
        polygonZkEVMGlobalExitRootMainnet = await PolygonZkEVMGlobalExitRootFactory.deploy(
            rollupManager.address,
            polygonZkEVMBridgeAContract.target
        );

        await polygonZkEVMBridgeAContract.initialize(
            networkIDMainnet,
            ethers.ZeroAddress, // zero for ether
            ethers.ZeroAddress, // zero for ether
            polygonZkEVMGlobalExitRootMainnet.target,
            rollupManager.address,
            "0x"
        );

        // deploy token
        const maticTokenFactory = await ethers.getContractFactory("ERC20PermitMock");
        polTokenContractNetwork0 = await maticTokenFactory.deploy(
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

        // deploy global exit root manager
        polygonZkEVMGlobalExitRootRollup = await PolygonZkEVMGlobalExitRootFactory.deploy(
            rollupManager.address,
            polygonZkEVMBridgeBContract.target
        );

        await polygonZkEVMBridgeBContract.initialize(
            networkIDRollup,
            ethers.ZeroAddress, // zero for ether
            ethers.ZeroAddress, // zero for ether
            polygonZkEVMGlobalExitRootRollup.target,
            rollupManager.address,
            "0x"
        );
    });

    it("simulates a dependant bridge", async () => {
        //////////////////////////////////
        //////////// Bridge A ////////////
        //////////////////////////////////

        let originNetwork = networkIDMainnet;
        let destinationNetwork = networkIDRollup;
        let merkleTreeJSMainnet = new MerkleTreeBridge(HEIGHT);

        let totalAmountBridgeA: bigint = BigInt(0);
        let depositCountBridgeA = 0;
        let rootJSMainnetBridgeA = ethers.ZeroHash;
        let mainnetExitRootBridgeA = ethers.ZeroHash;

        await transferAndApprove(
            polygonZkEVMBridgeAContract,
            polTokenContractNetwork0,
            AMOUNT * BigInt(NUMBER_OF_LEAVES_PER_BRIDGE),
            acc1
        );

        for (let i = 0; i < NUMBER_OF_LEAVES_PER_BRIDGE; i++) {
            addLeafToJsTree(
                merkleTreeJSMainnet,
                LEAF_TYPE_ASSET,
                originNetwork,
                polTokenContractNetwork0.target as string,
                destinationNetwork,
                userB,
                AMOUNT,
                metadataToken
            );

            rootJSMainnetBridgeA = merkleTreeJSMainnet.getRoot();
            mainnetExitRootBridgeA = await polygonZkEVMGlobalExitRootMainnet.lastMainnetExitRoot();

            await bridgeAsset(
                LEAF_TYPE_ASSET,
                originNetwork,
                polTokenContractNetwork0.target as string,
                destinationNetwork,
                userB,
                AMOUNT,
                metadataToken,
                depositCountBridgeA,
                polygonZkEVMBridgeAContract,
                polygonZkEVMGlobalExitRootMainnet,
                acc1,
                rootJSMainnetBridgeA,
                mainnetExitRootBridgeA,
                polTokenContractNetwork0
            );

            totalAmountBridgeA += AMOUNT;
            depositCountBridgeA += 1;
        }

        await polygonZkEVMBridgeAContract.updateGlobalExitRoot();
        let computedGlobalExitRoot = calculateGlobalExitRoot(rootJSMainnetBridgeA, mainnetExitRootBridgeA);
        expect(computedGlobalExitRoot).to.be.equal(await polygonZkEVMGlobalExitRootMainnet.getLastGlobalExitRoot());
        expect(await polTokenContractNetwork0.balanceOf(userA)).to.be.equal(0);
        await printBridgeEvents(polygonZkEVMBridgeAContract, depositCountBridgeA);

        // print out user B's balance
        // console.log("userB balance", await polTokenContractNetwork0.balanceOf(userB));

        //////////////////////////////////
        //////////// Bridge B ////////////
        //////////////////////////////////

        originNetwork = networkIDRollup;
        destinationNetwork = networkIDRollup2;
        let merkleTreeJSRollup = new MerkleTreeBridge(HEIGHT);

        let totalAmountBridgeB: bigint = BigInt(0);
        let depositCountBridgeB = 0;
        let rootJSRollupBridgeB = ethers.ZeroHash;
        let rollupExitRootBridgeB = ethers.ZeroHash;

        // const tokenWrappedFactory = await ethers.getContractFactory("TokenWrapped");
        // const salt = ethers.solidityPackedKeccak256(["uint32", "address"], [networkIDRollup, bridgeATokenAddress]);
        // const minimalBytecodeProxy = await bridgeB.BASE_INIT_BYTECODE_WRAPPED_TOKEN();
        // const hashInitCode = ethers.solidityPackedKeccak256(["bytes", "bytes"], [minimalBytecodeProxy, metadataToken]);
        // const precalculateWrappedErc20 = ethers.getCreate2Address(
        //     bridgeB.target as string,
        //     salt,
        //     hashInitCode
        // );
        // const newWrappedToken = tokenWrappedFactory.attach(precalculateWrappedErc20) as TokenWrapped;
        // bridgeBTokenAddress = newWrappedToken.target;

        await transferAndApprove(
            polygonZkEVMBridgeBContract,
            polTokenContractNetwork0,
            AMOUNT * BigInt(NUMBER_OF_LEAVES_PER_BRIDGE),
            acc2
        );

        for (let i = 0; i < NUMBER_OF_LEAVES_PER_BRIDGE; i++) {
            addLeafToJsTree(
                merkleTreeJSRollup,
                LEAF_TYPE_ASSET,
                originNetwork,
                polTokenContractNetwork0.target as string,
                destinationNetwork,
                userC,
                AMOUNT,
                metadataToken
            );

            rootJSRollupBridgeB = merkleTreeJSRollup.getRoot();
            rollupExitRootBridgeB = await polygonZkEVMGlobalExitRootRollup.lastRollupExitRoot();

            await bridgeAsset(
                LEAF_TYPE_ASSET,
                originNetwork,
                polTokenContractNetwork0.target as string,
                destinationNetwork,
                userC,
                AMOUNT,
                metadataToken,
                depositCountBridgeB,
                polygonZkEVMBridgeBContract,
                polygonZkEVMGlobalExitRootRollup,
                acc2,
                rootJSRollupBridgeB,
                rollupExitRootBridgeB,
                polTokenContractNetwork0
            );

            totalAmountBridgeB += AMOUNT;
            depositCountBridgeB += 1;
        }

        await polygonZkEVMBridgeBContract.updateGlobalExitRoot();
        computedGlobalExitRoot = calculateGlobalExitRoot(rootJSRollupBridgeB, rollupExitRootBridgeB);
        expect(computedGlobalExitRoot).to.be.equal(await polygonZkEVMGlobalExitRootRollup.getLastGlobalExitRoot());
        expect(await polTokenContractNetwork0.balanceOf(userB)).to.be.equal(0);
        await printBridgeEvents(polygonZkEVMBridgeBContract, depositCountBridgeB);
    });
});
