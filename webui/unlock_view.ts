/// <reference path="../typings/react-0.12.d.ts" />

// View for entering master password and unlocking the store

import react = require('react');
import typed_react = require('typed-react');

import item_store = require('../lib/item_store');
import reactutil = require('./reactutil');

enum UnlockState {
	Locked,
	Unlocking,
	Failed,
	Success
}

interface UnlockViewState {
	unlockState?: UnlockState;
	failedUnlockCount?: number;
}

export class UnlockViewProps {
	store: item_store.Store;
	isLocked: boolean;
	onUnlock: () => void;
	onUnlockErr: (error: string) => void;
}

export class UnlockView extends typed_react.Component<UnlockViewProps, UnlockViewState> {
	getInitialState() {
		return {
			unlockState: UnlockState.Locked,
			failedUnlockCount: 0
		};
	}

	componentDidMount() {
		var masterPassField = <HTMLInputElement>this.refs['masterPassField'].getDOMNode();
		masterPassField.focus();
	}

	render() {
		if (!this.props.isLocked) {
			return react.DOM.div({});
		}

		var unlockMessage : string;
		if (this.state.unlockState == UnlockState.Unlocking) {
			unlockMessage = 'Unlocking...';
		} else if (this.state.unlockState == UnlockState.Failed) {
			unlockMessage = '';
		}

		return react.DOM.div({className: 'unlockPane'},
			react.DOM.div({className:'unlockPaneForm'},
				react.DOM.form({
					className: 'unlockPaneInputs',
					ref:'unlockPaneForm',
					onSubmit: (e) => {
						e.preventDefault();
						var masterPass = (<HTMLInputElement>this.refs['masterPassField'].getDOMNode()).value;
						this.tryUnlock(masterPass);
					}
				},
					react.DOM.input({
						className: 'masterPassField',
						type: 'password',
						placeholder: 'Master Password...',
						ref: 'masterPassField',
						autoFocus: true
					}),
					react.DOM.div({className: 'unlockLabel'}, unlockMessage)
				)
			)
		);
	}

	private tryUnlock(password: string) {
		this.setState({unlockState: UnlockState.Unlocking});
		this.props.store.unlock(password).then(() => {
			this.setState({unlockState: UnlockState.Success});
			this.props.onUnlock();
		})
		.catch((err) => {
			this.setState({
				failedUnlockCount: this.state.failedUnlockCount + 1,
				unlockState: UnlockState.Failed
			});

			if (this.state.failedUnlockCount < 3) {
				this.props.onUnlockErr(err.message);
			} else {
				this.props.store.passwordHint().then((hint) => {
					if (!hint) {
						hint = '(No password hint set)';
					}
					this.props.onUnlockErr(err.message + '. Hint: ' + hint);
				}).catch((hintErr) => {
					this.props.onUnlockErr(err.message + '. Hint: ' + hintErr.message);
				});
			}
		});
	}
}

export var UnlockViewF = reactutil.createFactory(UnlockView);
