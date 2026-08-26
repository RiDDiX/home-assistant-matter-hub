import type { BridgeFeatureFlags } from "@home-assistant-matter-hub/common";
import { GeneralCommissioningServer } from "@matter/main/behaviors";
import { GeneralCommissioning } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";

// #449: Alexa invokes SetTcAcknowledgements during pairing. matter.js does not
// implement the TermsAndConditions feature, so the command fails as
// unsupported and some Echo firmwares stall after attestation. Accept the
// acknowledgement, enforce nothing.
const TcBase = GeneralCommissioningServer.with(
  GeneralCommissioning.Feature.TermsAndConditions,
);

export class TcGeneralCommissioningServer extends TcBase {
  declare state: TcGeneralCommissioningServer.State;

  override setTcAcknowledgements({
    tcVersion,
  }: GeneralCommissioning.SetTcAcknowledgementsRequest): GeneralCommissioning.SetTcAcknowledgementsResponse {
    this.state.tcAcceptedVersion = tcVersion;
    // ponytail: the response map is not stored, map16 state only takes bitmap
    // objects and the model names no bits. Nothing reads it back.
    return { errorCode: GeneralCommissioning.CommissioningError.Ok };
  }
}

export namespace TcGeneralCommissioningServer {
  export class State extends TcBase.State {
    override tcAcceptedVersion = 0;
    override tcMinRequiredVersion = 0;
    // typed number upstream, managed as a bitmap object at runtime
    override tcAcknowledgements = {} as unknown as number;
    // model default is true, but nothing is enforced here
    override tcAcknowledgementsRequired = false;
    override tcUpdateDeadline = null;
  }
}

export function rootEndpointType(flags?: BridgeFeatureFlags) {
  return flags?.supportTermsAndConditions
    ? ServerNode.RootEndpoint.with(TcGeneralCommissioningServer)
    : ServerNode.RootEndpoint;
}
