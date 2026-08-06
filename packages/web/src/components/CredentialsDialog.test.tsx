/**
 * CredentialsDialog tests: two-step confirm -> one-time password.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n/I18nContext";

const devicesApi = {
  issueCredentials: mock(async () => ({
    device_id: "d1",
    mqtt_username: "uid-1",
    mqtt_password: "pw-once-123",
    note: "shown once",
  })),
};
mock.module("../api/devices", () => devicesApi);

const { CredentialsDialog } = await import("./CredentialsDialog");

function renderDialog(onIssued = mock(() => {})) {
  return render(
    <I18nProvider>
      <CredentialsDialog deviceId="d1" open onClose={() => {}} onIssued={onIssued} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  devicesApi.issueCredentials.mockClear();
  devicesApi.issueCredentials.mockResolvedValue({
    device_id: "d1",
    mqtt_username: "uid-1",
    mqtt_password: "pw-once-123",
    note: "shown once",
  });
});

describe("CredentialsDialog", () => {
  test("asks for confirmation first", () => {
    renderDialog();
    expect(
      screen.getByRole("button", { name: /确认发放|Issue|Выпустить/i }),
    ).not.toBeNull();
  });

  test("issues credentials and shows the one-time password", async () => {
    const onIssued = mock(() => {});
    renderDialog(onIssued);
    await userEvent.click(
      screen.getByRole("button", { name: /确认发放|Issue|Выпустить/i }),
    );
    await waitFor(() =>
      expect(screen.getByText(/已发放|issued|выпущены/i)).not.toBeNull(),
    );
    expect(screen.getByText("uid-1")).not.toBeNull();
    expect(screen.getByText("pw-once-123")).not.toBeNull();
    expect(devicesApi.issueCredentials).toHaveBeenCalledWith("d1");
    expect(onIssued).toHaveBeenCalled();
  });

  test("shows the error and stays on the confirm step", async () => {
    devicesApi.issueCredentials.mockRejectedValue(new Error("boom"));
    renderDialog();
    await userEvent.click(
      screen.getByRole("button", { name: /确认发放|Issue|Выпустить/i }),
    );
    await waitFor(() => expect(screen.getByText("boom")).not.toBeNull());
    // still on the confirm step
    expect(
      screen.getByRole("button", { name: /确认发放|Issue|Выпустить/i }),
    ).not.toBeNull();
  });
});
