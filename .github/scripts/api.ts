// Every host function a plugin can call, by risk tier. Mirrors the GUI's Lua
// API reference (docs/plugins.md in ChameleonUltraGUI); calls missing from
// this table are flagged, so add new GUI functions here when they ship.
//
// read:      no lasting effect (dialogs, codecs, reading cards or the device)
// write:     changes saved data, GUI settings or device/emulator state
// dangerous: deletes data, can permanently damage cards/devices, or bypasses
//            the typed API (raw firmware/RF commands); every update needs a human

export const TIERS = ['read', 'write', 'dangerous'] as const
export type Tier = (typeof TIERS)[number]

const api: Record<string, Partial<Record<Tier, string>>> = {
  ui: { read: 'info warning error snackbar input' },
  resources: { read: 'get require' },
  codec: {
    read: 'base64Encode base64Decode compress decompress base64EncodeBytes base64DecodeBytes compressBytes decompressBytes',
  },
  recovery: { read: 'darkside nested staticNested staticEncryptedNested mfkey32 mfkey64 hardNested' },
  settings: { read: 'get options', write: 'update' },
  cards: { read: 'list get decode encode read', write: 'save move', dangerous: 'delete write' },
  dictionaries: { read: 'list get decode encode', write: 'save move', dangerous: 'delete' },
  cardFolders: { read: 'list export', write: 'save import', dangerous: 'delete' },
  dictionaryFolders: { read: 'list export', write: 'save import', dangerous: 'delete' },
  slots: {
    read: 'read getSlotTagName getActiveSlot getSlotTagNames getSlotTagTypes getEnabledSlots',
    write: 'load activateSlot setSlotType setDefaultDataToSlot enableSlot setSlotTagName saveSlotData',
    dangerous: 'deleteSlotInfo deleteSlotTagNick',
  },
  classic: {
    read: `checkKeys recover read detectMf1Support getMf1NTLevel mf1Auth mf1AuthMultipleKeys mf1ReadBlock
      isMf1DetectionMode getMf1DetectionCount isMf1Gen1aMode isMf1Gen2Mode isMf1UseFirstBlockColl getMf1WriteMode
      getMf1PrngType mf1GetEmulatorBlock mf1GetAntiCollData mf1GetFieldOffDoReset getMf1NTDistance
      getMf1NestedNonces mf1CheckKeysOfSectors getMf1Darkside getMf1EmulatorSettings`,
    write: `setMf1DetectionStatus setMf1BlockData setMf1Gen1aMode setMf1Gen2Mode setMf1UseFirstBlockColl
      setMf1WriteMode setMf1PrngType mf1SetFieldOffDoReset`,
    dangerous: 'mf1WriteBlock',
  },
  ultralight: {
    read: `mf0UlcAuth mf0UlcReadPages mf0GetMagicMode mf0EmulatorReadPages mf0EmulatorGetVersionData
      mf0EmulatorGetSignatureData mf0EmulatorGetPageCount mf0NtagGetWriteMode mf0NtagGetDetectionEnable
      mf0NtagGetDetectionCount mf0NtagGetDetectionLog mf0NtagGetEmulatorConfig`,
    write: `mf0SetMagicMode mf0EmulatorWritePages mf0EmulatorSetVersionData mf0EmulatorSetSignatureData
      mf0ResetAuthCount mf0EmulatorSetCounterData mf0NtagSetWriteMode mf0NtagSetDetectionEnable`,
    dangerous: 'mf0UlcWritePage mf0UlcSetKey',
  },
  device: {
    read: `connected enums readEM410X readHIDProx readViking readPac readIoProx readJablotron getDeviceChipID
      getDeviceBLEAddress isReaderDeviceMode scan14443aTag checkMf1Darkside getAnimationMode getGitCommitHash
      getButtonConfig getLongButtonConfig getSleepTimeout getLongPressThreshold getBLEConnectionKey
      isBLEPairEnabled getEM410XEmulatorID getDeviceCapabilities scan14443aTagKeep ioProxDecodeRaw
      ioProxComposeID adcGenericRead hf14a4EmvScan lfSniff hf14aSniff getFirmwareVersion getBatteryCharge
      getDeviceSettings`,
    write: `setReaderDeviceMode setEM410XEmulatorID setHIDProxEmulatorID setVikingEmulatorID setPacEmulatorID
      setIoProxEmulatorID setJablotronEmulatorID setIdteckEmulatorID saveSettings setAnimationMode
      setButtonConfig setLongButtonConfig setSleepTimeout setLongPressThreshold hf14aSetFieldOn hf14aSetFieldOff
      hf14aSetConfig hf14a4ApduSend hf14a4SetAntiColl hf14a4AddStaticResponse hf14a4ClearStaticResponses`,
    dangerous: `raw send14ARaw hf14a4ReaderApdu writeEM410XtoT55XX writeHIDProxToT55XX writeVikingToT55XX
      writeJablotronToT55XX writePacToT55XX writeIoProxToT55XX writeIdteckToT55XX enterDFUMode factoryReset
      resetSettings clearBLEBoundedDevices setBLEConnectKey setBLEPairEnabled`,
  },
}

/** Tier of each host call, keyed `namespace.function` (without the `chameleon.` prefix). */
export const API_TIERS: ReadonlyMap<string, Tier> = new Map(
  Object.entries(api).flatMap(([namespace, tiers]) =>
    TIERS.flatMap(tier => (tiers[tier] ?? '').split(/\s+/).filter(Boolean).map(fn => [`${namespace}.${fn}`, tier] as const)),
  ),
)
