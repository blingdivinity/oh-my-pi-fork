declare module "*.css";

interface OmpWebBootstrap {
	profile: "local";
	wsPath: string;
	token: string;
}

interface Window {
	__OMP_WEB?: OmpWebBootstrap;
}
