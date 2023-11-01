"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { ipfsUploadFile } from "crossbell/ipfs";
import { crossbell } from "crossbell/network";
import {
    CharacterMetadata,
    NoteMetadata,
    Numberish,
    createContract,
} from "crossbell";
import CryptoJS from "crypto-js";
import { formatEther } from "viem";
import { blackLists } from "./blacklist";

interface Moment {
    content: string;
    type: "share" | "text";
    images: string[];
    display_images?: string[];
    share_title: string;
    share_desc: string;
    share_url: string;
    share_image?: string;
    publish_time: string;
    id: string;
}

interface Account {
    banner: string;
    displayBanner?: string;
    avatar: string;
    displayAvatar?: string;
    nickname: string;
    id: string;
    bio?: string;
}

function getMoments(order: "desc" | "asc" = "desc") {
    // const data = require("../public/moments.json");
    const data = require("../public/qqzone.json");
    const allMoments = data.moments as Moment[];
    const account = data.account as Account;

    const moments = allMoments
        .filter((moment) => !blackLists.includes(moment.id))
        .sort((a, b) => {
            return +a.publish_time - +b.publish_time;
        });

    return {
        moments: order == "asc" ? moments : moments.reverse(),
        account,
    };
}

function prepareMoment(moment: Moment, useLocal: boolean) {
    const display_images = [] as string[];
    const images = moment.images;
    for (const img of moment.images) {
        if (img.endsWith("/150")) {
            if (images.includes(img.replace("/150", "/0"))) {
                continue;
            }
        }
        const imgUrl = useLocal
            ? `/images/${Buffer.from(img).toString("base64")}.jpg`
            : img;
        display_images.push(imgUrl);
    }

    moment.display_images = display_images;

    const isNull = (str: string | undefined) => {
        return str === undefined || str === null || str === "";
    };

    if (
        isNull(moment.share_desc) &&
        isNull(moment.share_title) &&
        isNull(moment.share_url)
    ) {
        moment.type = "text";
    }

    if (moment.type == "share") {
        if (moment.display_images.length > 1) {
            console.warn(
                "Share moment has more than one image. There might be some parsing error."
            );
        }
        moment.share_image = moment.display_images[0] || "";
    }

    return moment;
}

function prepareMoments(useLocal: boolean, order: "desc" | "asc" = "desc") {
    const { moments, account } = getMoments(order);

    const formattedMoments = [] as Moment[];

    for (const moment of moments) {
        formattedMoments.push(prepareMoment(moment, useLocal));
    }
    if (useLocal) {
        account.displayAvatar = account?.avatar
            ? `/images/${Buffer.from(account.avatar).toString("base64")}.jpg`
            : "";
        account.displayBanner = account?.banner
            ? `/images/${Buffer.from(account.banner).toString("base64")}.jpg`
            : "";
    } else {
        account.displayAvatar = account.avatar;
        account.displayBanner = account.banner;
    }

    return {
        moments: formattedMoments,
        account: account
            ? account
            : {
                  id: CryptoJS.MD5("id").toString(),
                  nickname: "",
                  avatar: "",
                  banner: "",
                  displayAvatar: "",
                  displayBanner: "",
              },
    };
}

async function addCrossbell() {
    const chainId = "0x" + crossbell.id.toString(16);
    return await (window as any).ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
            {
                chainId: chainId,
                chainName: crossbell.name,
                nativeCurrency: crossbell.nativeCurrency,
                rpcUrls: ["https://rpc.crossbell.io"],
                iconUrls: [],
                blockExplorerUrls: ["https://scan.crossbell.io"],
            },
        ],
    });
}

async function switchCrossbell() {
    const chainId = "0x" + crossbell.id.toString(16);
    return await (window as any).ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [
            {
                chainId,
            },
        ],
    });
}

async function prepareWallet() {
    if (!(window as any).ethereum) {
        return false;
    }
    await (window as any).ethereum.request({
        method: "eth_requestAccounts",
    });
    await addCrossbell();
    await switchCrossbell();
    return true;
}

async function uploadImg(img: string) {
    const blob = await fetch(img).then((res) => res.blob());
    return ipfsUploadFile(blob);
}

async function makeIpfsUrl(localUri: string) {
    const { cid } = await uploadImg(localUri);
    return `ipfs://${cid}`;
}

const makeNotesData = (
    useLocal: boolean,
    imageUrls: Map<string, string>,
    wxCharacter: Numberish,
    moments: Moment[]
) => {
    return moments.map((moment) => {
        const baseNote = {
            characterId: wxCharacter,
            metadataOrUri: {
                date_published: new Date(+moment.publish_time).toISOString(),
                sources: ["wechat-moments-exporter"],
            } as NoteMetadata,
        };
        if (moment.type === "share" && moment.share_url) {
            const shareImage = useLocal
                ? imageUrls.get(moment.share_image!)
                : moment.share_image!;
            baseNote.metadataOrUri.content = `<p>${moment.content}<br><br><a href=\"${moment.share_url}\" target=\"_blank\" rel=\"noopener\">${moment.share_url}</a></p><blockquote><b>${moment.share_title}</b><br><p>${moment.share_desc}</p><img src=\"${shareImage}\" referrerpolicy=\"no-referrer\"></blockquote>`;
        } else {
            baseNote.metadataOrUri.content = moment.content;
            baseNote.metadataOrUri.attachments = moment.display_images?.map(
                (image) => ({
                    address: useLocal ? imageUrls.get(image)! : image,
                    mime_type: "image/jpeg",
                })
            );
        }
        return baseNote;
    });
};

const estimateBatch = (objects: any[]) => {
    const roughObjSize = JSON.stringify(
        objects,
        (key, value) => (typeof value === "bigint" ? value.toString() : value) // return everything else unchanged
    ).length;
    const batchCount = Math.ceil((roughObjSize * 3) / 128000);
    const batchSize = Math.ceil(objects.length / batchCount);
    return { batchCount, batchSize };
};

async function process(useLocal: boolean, setInfo: (info: string) => void) {
    let info = "";
    const success = await prepareWallet();
    if (!success) {
        info = "请先安装并登录 metamask";
        setInfo(info);
        return;
    }

    // 0. connect the wallet and crossbell
    const { moments, account } = prepareMoments(useLocal, "asc");
    const contract = createContract((window as any).ethereum);
    info += `\n🎉 钱包配置成功（连接地址: ${contract.account.address}）`;
    setInfo(info);
    const { data } = await contract.csb.getBalance({
        owner: contract.account.address,
    });

    // 1. check balance
    const balance = +formatEther(data);
    const roughNotes = makeNotesData(useLocal, new Map(), 123456, moments);
    const { batchCount, batchSize } = estimateBatch(roughNotes);
    const estGas = +formatEther(BigInt(batchCount * 11540011 + 315103), "gwei");
    // multiple times of posting notes and one character creation
    if (balance < estGas) {
        console.log(
            "balance: " + balance + " CSB; estimated gas: " + estGas + "CSB"
        );
        info +=
            "\nbalance: " +
            balance +
            " CSB; estimated gas: " +
            estGas +
            "CSB" +
            '\n余额可能不足，请去<a style="color:red" href="https://faucet.crossbell.io/" target="_blank">水龙头</a>领取 Gas 进行充值，或加入 <a  style="color:red" href="https://discord.gg/S2Xdqu8M">Discord</a> 联系管理员';
        setInfo(info);
        return;
    }

    // 2. create character
    let avatarUrl = account.avatar;
    let bannerUrl = account.banner;

    if (useLocal) {
        avatarUrl = await makeIpfsUrl(account.displayAvatar!);
        bannerUrl = await makeIpfsUrl(account.displayBanner!);
    }

    const handle = "wx-" + CryptoJS.MD5(account.id).toString().slice(0, 8);

    const characterProfile = {
        owner: contract.account.address,
        handle,
        metadataOrUri: {
            name: account.nickname,
        } as CharacterMetadata,
    };

    if (account.banner)
        characterProfile.metadataOrUri.banners = [
            { address: bannerUrl, mime_type: "image/jpeg" },
        ];

    if (account.avatar) characterProfile.metadataOrUri.avatars = [avatarUrl];

    if (account.bio) characterProfile.metadataOrUri.bio = account.bio;

    info += `\n准备创建 character:\n <code>profile data: ${JSON.stringify(
        characterProfile
    )}</code>`;
    setInfo(info);

    const res = await contract.character.create(characterProfile);
    const wxCharacter = res.data;

    info += `\n🎉 character 创建成功: #${wxCharacter}`;
    setInfo(info);

    // 3. upload images to ipfs
    const imageUrls = new Map<string, string>();
    if (useLocal) {
        const uploadImages = [] as string[];

        moments.map((moment) => {
            moment.display_images?.map((image) => {
                uploadImages.push(image);
            });
        });

        info += `\n准备上传图片（共${uploadImages.length}张）`;
        setInfo(info);

        await Promise.all(
            uploadImages.map(async (image) => {
                const url = await makeIpfsUrl(image);
                imageUrls.set(image, url);
            })
        );

        info += `\n🎉 图片上传完毕`;
        setInfo(info);
    }

    // 4. post notes
    const notes = makeNotesData(useLocal, imageUrls, wxCharacter, moments);
    console.log(notes);

    info += `\n共${notes.length}条内容（可在控制台查看详细内容），准备分批上传（共${batchCount}批，每批${batchSize}条）`;
    setInfo(info);

    for (let i = 0; i < notes.length; i += batchSize) {
        const batch = notes.slice(i, i + batchSize);
        await contract.note.postMany({
            notes: batch,
        });
        info += `\n已上传 ${i + batch.length} 条内容`;
        setInfo(info);
    }

    info += `\n🎉 所有内容上传成功！可在 <a href="https://xfeed.app/u/${handle}">https://xfeed.app/u/${handle}</a> 查看自己的朋友圈！`;
    setInfo(info);
}

export default function Home() {
    const [useLocal, setUseLocal] = useState(true);
    const [info, setInfo] = useState("");

    const { moments, account } = prepareMoments(useLocal);

    return (
        <main className="container mx-auto p-10">
            <div className="relative w-full">
                <div className="relative h-[300px] overflow-hidden">
                    <Image
                        src={account.displayBanner!}
                        alt="banner"
                        fill
                        priority
                        style={{ objectFit: "cover", objectPosition: "center" }}
                    />
                </div>

                <div className="absolute bottom-[-55px] right-[55px]">
                    <Image
                        priority
                        src={account.displayAvatar!}
                        alt="Small Image Description"
                        width={110}
                        height={110}
                    />
                </div>
            </div>

            <div className="m-10">
                <div className="py-5">
                    <input
                        type="checkbox"
                        id="use-images"
                        defaultChecked={useLocal}
                        onClick={() => setUseLocal(!useLocal)}
                    />{" "}
                    <span>use local images (/public/images)</span>
                </div>
                <button
                    className="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-2 px-4 rounded"
                    onClick={() => process(useLocal, setInfo)}
                >
                    上链存储
                </button>
                <div
                    className="whitespace-pre-line"
                    dangerouslySetInnerHTML={{ __html: info }}
                ></div>
            </div>

            {moments.map((moment, index) => (
                <div key={moment.id}>
                    <div className="mx-10 my-4">
                        <p className="text-sm font-thin">{moment.id}</p>
                        <p>{new Date(moment.publish_time).toLocaleString()}</p>
                        {moment.type === "share" && moment.share_url ? (
                            <>
                                <p>{moment.share_url}</p>
                                <p className="text-xl whitespace-pre-line">
                                    {moment.content}
                                </p>

                                <div className="border p-4">
                                    <Link
                                        className="flex"
                                        href={moment.share_url}
                                    >
                                        {moment.share_image && (
                                            <div className="w-[109px] h-[109px] relative">
                                                <Image
                                                    priority
                                                    src={moment.share_image}
                                                    alt="moment"
                                                    fill
                                                    sizes="109px"
                                                    style={{
                                                        objectFit: "cover",
                                                    }}
                                                />
                                            </div>
                                        )}
                                        <div className="pl-5">
                                            <p className="text-xl">
                                                {moment.share_title}
                                            </p>
                                            <p className="text">
                                                {moment.share_desc}
                                            </p>
                                        </div>
                                    </Link>
                                </div>
                            </>
                        ) : (
                            <>
                                <p className="text-xl whitespace-pre-line">
                                    {moment.content}
                                </p>
                                <div className="grid grid-cols-3 gap-1 cols-3 w-[600px]">
                                    {moment.display_images!.map((image) => (
                                        <div
                                            key={image}
                                            className="w-[200px] h-[200px] relative"
                                        >
                                            <Image
                                                priority
                                                src={image}
                                                alt="moment"
                                                fill
                                                sizes="200px"
                                                style={{ objectFit: "cover" }}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                    <hr className="border-none mx-10 bg-gray-100 h-[0.2px]" />
                </div>
            ))}
        </main>
    );
}
