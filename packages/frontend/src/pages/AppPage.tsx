import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { ErrorBoundary } from "../components/misc/ErrorBoundary.tsx";
import { loadBridges } from "../state/bridges/bridge-actions.ts";
import { useAppDispatch } from "../state/hooks.ts";

export const AppPage = () => {
  const dispatch = useAppDispatch();
  const { pathname } = useLocation();

  useEffect(() => {
    dispatch(loadBridges());
  }, [dispatch]);

  // reset after a page crash when the user navigates away
  return (
    <ErrorBoundary key={pathname}>
      <Outlet />
    </ErrorBoundary>
  );
};
